'use strict';

const common = require('x2node-common');
const ws = require('x2node-ws');
const dbos = require('x2node-dbos');
const validators = require('x2node-validators');
const patches = require('x2node-patches');

const AbstractResourceHandler = require('./abstract-resource-handler.js');


/**
 * Create a deep copy of a value.
 *
 * @private
 * @param {*} val The value.
 * @returns {*} Deep copy of the value, or the value itself if simple value.
 */
function deepCopy(val) {

	let res;
	if (Array.isArray(val)) {
		res = [];
		for (let v of val)
			res.push(deepCopy(v));
	} else if (((typeof val) === 'object') && (val !== null)) {
		res = {};
		for (let k of Object.keys(val))
			res[k] = deepCopy(val[k]);
	} else {
		res = val;
	}

	return res;
}

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

	/**
	 * Default implementation for the <code>isAllowed()</code> method that calls
	 * handler's <code>isAllowedAction()</code> method.
	 *
	 * @private
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @returns {boolean} The <code>isAllowedAction()</code> method call result.
	 */
	_defaultIsAllowed(call) {

		let action;
		switch (call.method) {
		case 'GET':
			action = 'read';
			break;
		case 'PATCH':
			action = 'update';
			break;
		case 'DELETE':
			action = 'delete';
			break;
		}

		return this.isAllowedAction(action, call.actor, call);
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
			filter: this._createFilter(call, txCtx.queryParams),
			lock: 'shared'
		};

		// pre-resolve response promise
		let responsePromise = Promise.resolve();

		// custom preparation logic
		if ((typeof this.prepareRead) === 'function')
			responsePromise = responsePromise.then(() => Promise.resolve(
				this._callHook('prepareRead', txCtx)));

		// build the read DBO
		let readDBO;
		responsePromise = responsePromise.then(() => {

			// build the DBO
			// TODO: cache read DBO
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
		});

		// proceed to the transaction
		responsePromise = responsePromise.then(() => {

			// assemble transaction phases
			const txPhases = new Array();

			// custom tx setup hook
			if ((typeof this.beforeReadTx) === 'function')
				txPhases.push((_, txCtx) => this._callHook(
					'beforeReadTx', txCtx));

			// pre-fetch the record version info if complex query
			const versionInfoPrefetch = (
				this._isConditionalRequest(call) && (readDBO.complexity > 0));
			if (versionInfoPrefetch) {
				const response = this._addProcessConditionalRequestPhase(
					txPhases, call);
				if (response)
					return response;
			}

			// custom "before" hook
			if ((typeof this.beforeRead) === 'function')
				txPhases.push((_, txCtx) => this._callHook(
					'beforeRead', txCtx));

			// main action
			txPhases.push(
				(tx, txCtx) => readDBO.execute(
					tx, call.actor, txCtx.queryParams
				).then(result => {

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

					// save fetched referred records on the context
					txCtx.referredRecords = result.referredRecords;

					// get record version info
					const recVI = this._getRecordVersionInfo(call, rec);

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
				})
			);

			// custom "after" hook
			if ((typeof this.afterRead) === 'function')
				txPhases.push((_, txCtx, record) => this._callHook(
					'afterRead', txCtx, record));

			// execute the transaction
			return this._executeTransaction(txCtx, txPhases);
		});

		// custom completion logic
		if ((typeof this.completeRead) === 'function')
			responsePromise = responsePromise.then(
				record => Promise.resolve(this._callHook(
					'completeRead', undefined, txCtx, record)),
				err => Promise.reject(this._callHook(
					'completeRead', err, txCtx, undefined))
			);

		// build and return the response promise
		return responsePromise.then(result => {

			// check if already a response
			if (ws.isResponse(result))
				return result;

			// create and return respose
			return this._addValidatorHeaders(txCtx, ws.createResponse(200))
				.setEntity(result);
		});
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
		txPhases.push(
			(tx, txCtx) => videsc.versionInfoFetchDBO.execute(
				tx, txCtx.call.actor, {
					id: this._getRecordId(txCtx.call)
				}
			).then(result => {

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
			})
		);
	}

	/////////////////////////////////////////////////////////////////////////////
	// process PATCH call
	/////////////////////////////////////////////////////////////////////////////
	PATCH(call) {

		// transaction context
		const txCtx = this._createTransactionContext(call);
		txCtx.patchSpec = call.entity;

		// make sure that we have the entity
		if (!txCtx.patchSpec)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-4',
				errorMessage: 'Expected patch document in the request body.'
			});

		// create record selection filter specification
		txCtx.queryParams = new Object();
		txCtx.selectionFilter = this._createFilter(call, txCtx.queryParams);

		// pre-resolve response promise
		let responsePromise = Promise.resolve();

		// custom patch specification modification logic
		if ((typeof this.prepareUpdateSpec) === 'function')
			responsePromise = responsePromise.then(() => Promise.resolve(
				this._callHook('prepareUpdateSpec', txCtx, txCtx.patchSpec)));

		// build the patch
		responsePromise = responsePromise.then(() => {

			// check if patch was created by prepareUpdateSpec hook
			if (txCtx.patch)
				return;

			// parse the patch depending on the format
			try {
				switch (call.entityContentType) {
				case 'application/json-patch+json':
					txCtx.patch = patches.build(
						this._recordTypes, this._recordTypeName,
						txCtx.patchSpec);
					break;
				case 'application/merge-patch+json':
					txCtx.patch = patches.buildMerge(
						this._recordTypes, this._recordTypeName,
						txCtx.patchSpec);
				}
			} catch (err) {
				if (err instanceof common.X2SyntaxError) {
					return Promise.reject(ws.createResponse(400).setEntity({
						errorCode: 'X2-RSRC-400-5',
						errorMessage: `Invalid patch document: ${err.message}`
					}));
				}
				throw err;
			}

			// check if did not understand the patch format
			if (!txCtx.patch) {
				return Promise.reject(
					ws.createResponse(415)
						.setHeader(
							'Accept-Patch',
							'application/json-patch+json' +
								', application/merge-patch+json')
						.setEntity({
							errorCode: 'X2-RSRC-415-1',
							errorMessage: 'Unsupported patch document format.'
						}));
			}
		});

		// custom preparation logic
		if ((typeof this.prepareUpdate) === 'function')
			responsePromise = responsePromise.then(() => Promise.resolve(
				this._callHook('prepareUpdate', txCtx)));

		// proceed to the transaction
		const responseType = this._options.patch.response;
		responsePromise = responsePromise.then(() => {

			// build the DBOs
			const prefetchDBO = this._dboFactory.buildFetch(
				this._recordTypeName, {
					props: [ '*' ],
					filter: txCtx.selectionFilter,
					lock: 'exclusive'
				});

			// assemble transaction phases
			const txPhases = new Array();

			// custom tx setup hook
			if ((typeof this.beforeUpdateTx) === 'function')
				txPhases.push((_, txCtx) => this._callHook(
					'beforeUpdateTx', txCtx));

			// record fetch and pre-conditions check
			txPhases.push((tx, txCtx) => prefetchDBO.execute(
				tx, call.actor, txCtx.queryParams).then(result => {

					// check if got the record
					if (result.records.length === 0)
						return Promise.reject(
							ws.createResponse(404).setEntity({
								errorCode: 'X2-RSRC-404-1',
								errorMessage: 'Record not found.'
							}));

					// check pre-conditions
					const record = result.records[0];
					const recVI = this._getRecordVersionInfo(txCtx.call, record);
					const response = this._evaluatePreconditions(
						txCtx.call, recVI.etag, recVI.lastModified);
					if (response)
						return Promise.reject(response);

					// save the original record
					txCtx.originalRecord = deepCopy(record);

					// return the record
					return record;
				})
			);

			// custom "before" hook
			if ((typeof this.beforeUpdate) === 'function')
				txPhases.push((_, txCtx, record) => {
					const hookResult = this._callHook(
						'beforeUpdate', txCtx, record);
					if ((hookResult !== undefined) &&
						(hookResult !== null) &&
						((typeof hookResult.then) === 'function'))
						return hookResult.then(() => record);
					return record;
				});

			// apply patch and normalize the resulting record
			txPhases.push((_, txCtx, record) => {

				// apply the requested patch
				try {
					if (!txCtx.patch.apply(record))
						return Promise.reject(
							ws.createResponse(422).setEntity({
								errorCode: 'X2-RSRC-422-2',
								errorMessage: 'Patch "test" operation failed.'
							}));
				} catch (err) {
					if (err instanceof common.X2DataError) {
						return Promise.reject(
							ws.createResponse(400).setEntity({
								errorCode: 'X2-RSRC-400-8',
								errorMessage: 'Unable to apply' +
									` the patch: ${err.message}`
							}));
					}
					return Promise.reject(err);
				}

				// validate and normalize the record after patch
				const errors = validators.normalizeRecord(
					this._recordTypes, this._recordTypeName,
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

				// requested patch applied, continue
				return record;
			});

			// custom "before save" hook
			if ((typeof this.beforeUpdateSave) === 'function')
				txPhases.push((_, txCtx, record) => {
					const hookResult = this._callHook(
						'beforeUpdateSave', txCtx, record);
					if ((hookResult !== undefined) &&
						(hookResult !== null) &&
						((typeof hookResult.then) === 'function'))
						return hookResult.then(() => record);
					return record;
				});

			// prepare final patch and execute the update
			txPhases.push((tx, txCtx, record) => {

				// build the final patch and the update DBO
				const updateDBO = this._dboFactory.buildUpdate(
					this._recordTypeName,
					patches.build(
						this._recordTypes, this._recordTypeName,
						patches.fromDiff(
							this._recordTypes, this._recordTypeName,
							txCtx.originalRecord, record
						)
					),
					() => [ txCtx.originalRecord ]
				);

				// execute the DBO
				return updateDBO.execute(tx, call.actor).then(result => {
					txCtx.updateResult = result;
					delete txCtx.originalRecord;
					return result.records[0];
				});
			});

			// re-read updated record from the database if configured
			if (responseType === 'reread')
				txPhases.push(
					(tx, txCtx, record) => this._recordFetchByIdDBO.execute(
						tx, call.actor, {
							id: record[this._recordTypeDesc.idPropertyName]
						}).then(result => result.records[0]));

			// custom "after" hook
			if ((typeof this.afterUpdate) === 'function')
				txPhases.push((_, txCtx, record) => this._callHook(
					'afterUpdate', txCtx, record));

			// execute the transaction
			return this._executeTransaction(txCtx, txPhases);
		});

		// custom completion logic
		if ((typeof this.completeUpdate) === 'function')
			responsePromise = responsePromise.then(
				record => Promise.resolve(this._callHook(
					'completeUpdate', undefined, txCtx, record)),
				err => Promise.reject(this._callHook(
					'completeUpdate', err, txCtx, undefined))
			);

		// build and return the response promise
		return responsePromise.then(record => {

			// save updated record version information
			const recVI = this._getRecordVersionInfo(call, record);
			this._saveValidatorHeaders(txCtx, recVI.etag, recVI.lastModified);

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
		});
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
			responsePromise = responsePromise.then(() => Promise.resolve(
				this._callHook('prepareDelete', txCtx)));

		// proceed to the transaction
		responsePromise = responsePromise.then(() => {

			// build delete DBO
			// TODO: cache delete DBO
			const deleteDBO = this._dboFactory.buildDelete(
				this._recordTypeName, txCtx.selectionFilter);

			// assemble transaction phases
			const txPhases = new Array();

			// pproperties to fetch before deleting
			const fetchProps = (txCtx.fetchProps || []);
			const conditionalRequest = this._isConditionalRequest(call);
			if (conditionalRequest) {
				const versionPropsToAdd = new Set(
					this._recordVersionInfoDesc.versionProps);
				for (let prop of fetchProps) {
					if (prop === '*') {
						versionPropsToAdd.clear();
						break;
					}
					versionPropsToAdd.delete(prop);
				}
				for (let prop of versionPropsToAdd)
					fetchProps.push(prop);
			}

			// fetch the record
			if (fetchProps.length > 0)
				txPhases.push(
					(tx, txCtx) => this._dboFactory.buildFetch(
						this._recordTypeName, {
							props: fetchProps,
							filter: txCtx.selectionFilter,
							lock: 'exclusive'
						}
					).execute(
						tx, call.actor, txCtx.queryParams
					).then(result => {

						// check if invalid filter
						if (result.records.length > 1)
							throw new common.X2DataError(
								'More than one record matched selection' +
									' filter.');

						// check if record exists
						if (result.records.length === 0)
							return Promise.reject(
								ws.createResponse(404).setEntity({
									errorCode: 'X2-RSRC-404-1',
									errorMessage: 'Record not found.'
								}));

						// save fetch data in the context
						txCtx.record = result.records[0];
						txCtx.referredRecords = result.referredRecords;
					}));

			// add conditional request processing phase
			if (conditionalRequest)
				txPhases.push(
					(_, txCtx) => {
						const record = txCtx.record;
						let response;
						if (record) {
							const recVI = this._getRecordVersionInfo(
								call, record);
							response = this._evaluatePreconditions(
								call, recVI.etag, recVI.lastModified);
						} else {
							response = this._evaluatePreconditions(
								call, null, null);
						}
						if (response) {
							txCtx.makeComplete();
							return response;
						}
					});

			// custom "before" hook
			if ((typeof this.beforeDelete) === 'function')
				txPhases.push((_, txCtx) => this._callHook(
					'beforeDelete', txCtx, txCtx.record));

			// main action
			txPhases.push(
				(tx, txCtx) => deleteDBO.execute(
					tx, call.actor, txCtx.queryParams
				).then(result => {
					txCtx.deleteResult = result;
					if (!result[this._recordTypeName])
						return Promise.reject(
							ws.createResponse(404).setEntity({
								errorCode: 'X2-RSRC-404-1',
								errorMessage: 'Record not found.'
							}));
					return null;
				}));

			// custom "after" hook
			if ((typeof this.afterDelete) === 'function')
				txPhases.push((_, txCtx) => this._callHook(
					'afterDelete', txCtx, txCtx.record));

			// execute the transaction
			return this._executeTransaction(txCtx, txPhases);
		});

		// custom completion logic
		if ((typeof this.completeDelete) === 'function')
			responsePromise = responsePromise.then(
				() => Promise.resolve(this._callHook(
					'completeDelete', undefined, txCtx, txCtx.record)),
				err => Promise.reject(this._callHook(
					'completeDelete', err, txCtx, undefined))
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
}

// export the class
module.exports = IndividualResourceHandler;
