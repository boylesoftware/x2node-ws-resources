'use strict';

const common = require('x2node-common');
const ws = require('x2node-ws');
const dbos = require('x2node-dbos');
const validators = require('x2node-validators');
const patches = require('x2node-patches');

const AbstractResourceHandler = require('./abstract-resource-handler.js');


// TODO: support PUT for assigned id records

/**
 * Standard individual resource web wervice endpoint handler.
 *
 * @memberof module:x2node-ws-resources
 * @extends module:x2node-ws-resources~AbstractResourceHandler
 * @implements module:x2node-ws.Handler
 */
class IndividualResourceHandler extends AbstractResourceHandler {

	/**
	 * Create new handler.
	 *
	 * @param {module:x2node-dbos.DataSource} ds Data source.
	 * @param {module:x2node-dbos~DBOFactory} dboFactory DBO factory.
	 * @param {string} rsrcPath Resource path.
	 * @param {Object} [options] Options.
	 */
	constructor(ds, dboFactory, rsrcPath, options) {
		super(ds, dboFactory, rsrcPath, options);

		// build record fetch by id DBO
		this._recordFetchByIdDBO = this._dboFactory.buildFetch(
			this._recordTypeName, {
				filter: [
					[ this._recordTypeDesc.idPropertyName, dbos.param('id') ]
				]
			});
	}

	/////////////////////////////////////////////////////////////////////////////
	// process OPTIONS call
	/////////////////////////////////////////////////////////////////////////////
	OPTIONS(call, response) {

		response.setHeader(
			'Accept-Patch',
			'application/json-patch+json, application/merge-patch+json');
	}

	/////////////////////////////////////////////////////////////////////////////
	// process GET call
	/////////////////////////////////////////////////////////////////////////////
	GET(call) {

		// transaction context
		const txCtx = this._createTransactionContext(call);

		// determine selected properties
		const selectedProps = new Set();
		const propsParam = call.requestUrl.query.p;
		if (propsParam) {
			for (let p of propsParam.split(','))
				if (!p.startsWith('.'))
					selectedProps.add(p);
			for (let propName of this._recordVersionInfoDesc.versionProps)
				selectedProps.add(propName);
		} else {
			selectedProps.add('*');
		}

		// create query specification
		txCtx.queryParams = new Object();
		txCtx.querySpec = {
			props: Array.from(selectedProps),
			filter: this._createFilter(call, txCtx.queryParams)
		};

		// pre-resolve response promise
		let responsePromise = Promise.resolve();

		// custom preparation logic
		if ((typeof this.prepareRead) === 'function')
			responsePromise = responsePromise.then(
				() => Promise.resolve(this.prepareRead(txCtx))
			);

		// proceed to the transaction
		responsePromise = responsePromise.then(
			() => {

				// build read DBO
				// TODO: cache read DBO
				let readDBO;
				try {
					readDBO = this._dboFactory.buildFetch(
						this._recordTypeName, txCtx.querySpec);
				} catch (err) {
					if (err instanceof common.X2SyntaxError) {
						return Promise.reject(ws.createResponse(400).setEntity({
							errorCode: 'X2-RSRC-400-6',
							errorMessage: 'Invalid query string: ' + err.message
						}));
					}
					return Promise.reject(err);
				}

				// assemble transaction phases
				const txPhases = new Array();

				// pre-fetch the record version info if complex query
				const versionInfoPrefetch = (
					this._isConditionalRequest(call) &&
						(readDBO.complexity > 0));
				if (versionInfoPrefetch) {
					const response = this._addProcessConditionalRequestPhase(
						txPhases, call);
					if (response)
						return response;
				}

				// custom "before" hook
				if ((typeof this.beforeRead) === 'function')
					txPhases.push(
						(_, txCtx) => this.beforeRead(txCtx));

				// main action
				txPhases.push(
					(tx, txCtx) => readDBO.execute(
						tx, call.actor, txCtx.queryParams).then(
							result => {

								// check if record does not exist
								if (result.records.length === 0)
									return Promise.reject(
										ws.createResponse(404).setEntity({
											errorCode: 'X2-RSRC-404-1',
											errorMessage: 'Record not found.'
										})
									);

								// get the record
								const rec = result.records[0];

								// get record version info
								const recVI = this._getRecordVersionInfo(
									call, rec);

								// check pre-conditions if not checked yet
								if (!versionInfoPrefetch) {
									const response = this._evaluatePreconditions(
										call, recVI.etag, recVI.lastModified);
									if (response) {
										txCtx.makeComplete();
										return response;
									}
								}

								// save the version info on the context
								this._saveValidatorHeaders(
									txCtx, recVI.etag, recVI.lastModified);

								// return the record
								return rec;
							},

							// read DBO error
							err => Promise.reject(err)
						));

				// custom "after" hook
				if ((typeof this.afterRead) === 'function')
					txPhases.push(
						(_, txCtx, record) => this.afterRead(txCtx, record));

				// execute the transaction
				return this._executeTransaction(txCtx, txPhases);
			},

			// custom preparation logic error
			err => Promise.reject(err)
		);

		// custom completion logic
		if ((typeof this.completeRead) === 'function')
			responsePromise = responsePromise.then(
				record => Promise.resolve(
					this.completeRead(undefined, txCtx, record)),
				err => Promise.reject(
					this.completeRecord(err, txCtx, undefined))
			);

		// build and return the response promise
		return responsePromise.then(
			result => {

				// check if already a response
				if (ws.isResponse(result))
					return result;

				// create and return respose
				return this._addValidatorHeaders(txCtx, ws.createResponse(200))
					.setEntity(result);
			},
			err => Promise.reject(err)
		);
	}

	/////////////////////////////////////////////////////////////////////////////
	// process PATCH call
	/////////////////////////////////////////////////////////////////////////////
	PATCH(call) {

		// make sure that we have the entity
		const patchSpec = call.entity;
		if (!patchSpec)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-4',
				errorMessage: 'Expected patch document in the request body.'
			});

		// transaction context
		const txCtx = this._createTransactionContext(call);

		// parse the patch depending on the format
		try {
			switch (call.entityContentType) {
			case 'application/json-patch+json':
				txCtx.patch = patches.build(
					this._recordTypes, this._recordTypeName, patchSpec);
				break;
			case 'application/merge-patch+json':
				txCtx.patch = patches.buildMerge(
					this._recordTypes, this._recordTypeName, patchSpec);
			}
		} catch (err) {
			if (err instanceof common.X2SyntaxError) {
				return ws.createResponse(400).setEntity({
					errorCode: 'X2-RSRC-400-5',
					errorMessage: 'Invalid patch document: ' + err.message
				});
			}
			throw err;
		}

		// check if did not understand the patch format
		if (!txCtx.patch) {
			return ws.createResponse(415)
				.setHeader(
					'Accept-Patch',
					'application/json-patch+json, application/merge-patch+json')
				.setEntity({
					errorCode: 'X2-RSRC-415-1',
					errorMessage: 'Unsupported patch document format.'
				});
		}

		// create record selection filter specification
		txCtx.queryParams = new Object();
		txCtx.selectionFilter = this._createFilter(call, txCtx.queryParams);

		// pre-resolve response promise
		let responsePromise = Promise.resolve();

		// custom preparation logic
		if ((typeof this.prepareUpdate) === 'function')
			responsePromise = responsePromise.then(
				() => Promise.resolve(this.prepareUpdate(txCtx))
			);

		// proceed to the transaction
		const responseType = this._options.patch.response;
		responsePromise = responsePromise.then(
			() => {

				// build the DBOs
				const updateDBO = this._dboFactory.buildUpdate(
					this._recordTypeName, txCtx.patch, txCtx.selectionFilter);

				// assemble transaction phases
				const txPhases = new Array();

				// main action
				txPhases.push(
					(tx, txCtx) => updateDBO.execute(
						tx, call.actor, {
							beforePatch: record => {

								// check pre-conditions
								const recVI = this._getRecordVersionInfo(
									txCtx.call, record);
								const response = this._evaluatePreconditions(
									txCtx.call, recVI.etag, recVI.lastModified);
								if (response)
									return Promise.reject(response);

								// custom "before" hook
								if ((typeof this.beforeUpdate) === 'function')
									return this.beforeUpdate(txCtx, record);
							},
							afterPatch: record => {

								// validate and normalize record after patch
								const errors = validators.normalizeRecord(
									this._recordTypes,
									this._recordTypeName,
									record,
									call.httpRequest.headers['Accept-Language'],
									'onUpdate'
								);
								if (errors)
									return Promise.reject(
										ws.createResponse(422).setEntity({
											errorCode: 'X2-RSRC-422-1',
											errorMessage: 'Patch results in' +
												' invalid record data.',
											validationErrors: errors
										}));

								// custom "before save" hook
								if ((typeof this.beforeUpdateSave)
									=== 'function')
									return this.beforeUpdateSave(txCtx, record);
							}
						}, txCtx.queryParams).then(
							result => {
								txCtx.updateResult = result;
								if (result.records.length === 0)
									return Promise.reject(
										ws.createResponse(404).setEntity({
											errorCode: 'X2-RSRC-404-1',
											errorMessage: 'Record not found.'
										}));
								return result.records[0];
							},
							err => Promise.reject(err)
						));

				// re-read updated record from the database if configured
				if (responseType === 'reread')
					txPhases.push(
						(tx, txCtx, record) => this._recordFetchByIdDBO.execute(
							tx, call.actor, {
								id: record[this._recordTypeDesc.idPropertyName]
							}));

				// custom "after" hook
				if ((typeof this.afterUpdate) === 'function')
					txPhases.push(
						(_, txCtx, record) => this.afterUpdate(txCtx, record));

				// execute the transaction
				return this._executeTransaction(txCtx, txPhases);
			},

			// custom preparation logic error
			err => Promise.reject(err)
		);

		// custom completion logic
		if ((typeof this.completeUpdate) === 'function')
			responsePromise = responsePromise.then(
				record => Promise.resolve(
					this.completeUpdate(undefined, txCtx, record)),
				err => Promise.reject(
					this.completeUpdate(err, txCtx, undefined))
			);

		// build and return the response promise
		return responsePromise.then(
			record => {

				// save updated record version information
				const recVI = this._getRecordVersionInfo(call, record);
				this._saveValidatorHeaders(
					txCtx, recVI.etag, recVI.lastModified);

				// create response
				let response;
				switch (responseType) {
				case 'nocontent':
					response = ws.createResponse(204);
					break;
				default: // updated record in the response
					response = ws.createResponse(200)
						.setHeader('Content-Location', call.requestUrl.pathname)
						.setEntity(record);
				}

				// add record version informtation to the response and return it
				return this._addValidatorHeaders(txCtx, response);
			},
			err => Promise.reject(err)
		);
	}

	/////////////////////////////////////////////////////////////////////////////
	// process DELETE call
	/////////////////////////////////////////////////////////////////////////////
	DELETE(call) {

		// TODO: check existence of weakly dependent records

		// transaction context
		const txCtx = this._createTransactionContext(call);

		// create record selection filter specification
		txCtx.queryParams = new Object();
		txCtx.selectionFilter = this._createFilter(call, txCtx.queryParams);

		// pre-resolve response promise
		let responsePromise = Promise.resolve();

		// custom preparation logic
		if ((typeof this.prepareDelete) === 'function')
			responsePromise = responsePromise.then(
				() => Promise.resolve(this.prepareDelete(txCtx))
			);

		// proceed to the transaction
		responsePromise = responsePromise.then(
			() => {

				// build delete DBO
				// TODO: cache delete DBO
				const deleteDBO = this._dboFactory.buildDelete(
					this._recordTypeName, txCtx.selectionFilter);

				// assemble transaction phases
				const txPhases = new Array();

				// process conditional request
				if (this._isConditionalRequest(call))
					this._addProcessConditionalRequestPhase(txPhases, call);

				// custom "before" hook
				if ((typeof this.beforeDelete) === 'function')
					txPhases.push(
						(_, txCtx) => this.beforeDelete(txCtx));

				// main action
				txPhases.push(
					(tx, txCtx) => deleteDBO.execute(
						tx, call.actor, txCtx.queryParams).then(
							result => {
								txCtx.deleteResult = result;
								if (!result[this._recordTypeName])
									return Promise.reject(
										ws.createResponse(404).setEntity({
											errorCode: 'X2-RSRC-404-1',
											errorMessage: 'Record not found.'
										}));
								return null;
							},
							err => Promise.reject(err)
						));

				// custom "after" hook
				if ((typeof this.afterDelete) === 'function')
					txPhases.push(
						(_, txCtx) => this.afterDelete(txCtx));

				// execute the transaction
				return this._executeTransaction(txCtx, txPhases);
			},

			// custom preparation logic error
			err => Promise.reject(err)
		);

		// custom completion logic
		if ((typeof this.completeDelete) === 'function')
			responsePromise = responsePromise.then(
				() => Promise.resolve(
					this.completeDelete(undefined, txCtx)),
				err => Promise.reject(
					this.completeDelete(err, txCtx))
			);

		// return the response promise
		return responsePromise;
	}

	/////////////////////////////////////////////////////////////////////////////
	// common methods
	/////////////////////////////////////////////////////////////////////////////

	/**
	 * Create full filter specification for the addressed record including its id
	 * and the uplink records.
	 *
	 * @private
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @param {Object.<string,*>} queryParams DBO query parameters to populate.
	 * @returns {Array} Filter specification for the DBO.
	 */
	_createFilter(call, queryParams) {

		return this._addUplinkFilters(
			call, -2, this._createIdFilter(call, queryParams), queryParams);
	}

	/**
	 * Create filter specification for the addressed record using only its id.
	 *
	 * @private
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @param {Object.<string,*>} queryParams DBO query parameters to populate.
	 * @returns {Array} Filter specification for the DBO.
	 */
	_createIdFilter(call, queryParams) {

		const filter = new Array();

		filter.push([ this._recordTypeDesc.idPropertyName, dbos.param('id') ]);

		queryParams['id'] = this._getRecordId(call);

		return filter;
	}

	/**
	 * Get addressed record id from the call URI.
	 *
	 * @private
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @returns {(number|string)} The record id.
	 */
	_getRecordId(call) {

		const idPropDesc = this._recordTypeDesc.getPropertyDesc(
			this._recordTypeDesc.idPropertyName);
		return (
			idPropDesc.scalarValueType === 'number' ?
				Number(call.uriParams[call.uriParams.length - 1]) :
				call.uriParams[call.uriParams.length - 1]
		);
	}

	/**
	 * Add transaction phase for pre-fetching record version information with a
	 * simple query and checking conditional request's pre-conditions.
	 *
	 * @private
	 * @param {Array.<module:x2node-ws-resources~AbstractResourceHandler~transactionPhase>} txPhases
	 * Transaction phases list, to which to add the phase.
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @returns {module:x2node-ws.ServiceResponse} Service response if execution
	 * of the call can/must be stoped (record type has no version info and
	 * pre-conditions failed), or nothing if it needs to continue.
	 */
	_addProcessConditionalRequestPhase(txPhases, call) {

		// check pre-conditions right away if no record version info
		const videsc = this._recordVersionInfoDesc;
		if (videsc.versionProps.length === 0)
			return this._evaluatePreconditions(call, null, null);

		// pre-fetch the record version info and evaluate the pre-conditions
		txPhases.push((tx, txCtx) => videsc.versionInfoFetchDBO.execute(
			tx, txCtx.call.actor, { id: this._getRecordId(call) }).then(
				result => {

					// check if record does not exist
					if (result.records.length === 0)
						return Promise.reject(
							ws.createResponse(404).setEntity({
								errorCode: 'X2-RSRC-404-1',
								errorMessage: 'Record not found.'
							}));

					// evaluate pre-conditions
					const recVI = this._getRecordVersionInfo(
						txCtx.call, result.records[0]);
					const response = this._evaluatePreconditions(
						txCtx.call, recVI.etag, recVI.lastModified);
					if (response) {
						txCtx.makeComplete();
						return response;
					}
				},

				// pre-fetch DBO error
				err => Promise.reject(err)
			));
	}
}

// export the class
module.exports = IndividualResourceHandler;
