'use strict';

const common = require('x2node-common');
const ws = require('x2node-ws');
const dbos = require('x2node-dbos');
const validators = require('x2node-validators');
const patches = require('x2node-patches');

const AbstractResourceHandler = require('./abstract-resource-handler.js');


// TODO: cache DBOs
// TODO: add ETags
// TODO: support PUT for assigned id records

/**
 * Standard individual resource web wervice endpoint handler.
 *
 * @memberof module:x2node-ws-resources
 * @extends module:x2node-ws~AbstractResourceHandler
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

		// create query specification
		txCtx.queryParams = new Object();
		const propsParam = call.requestUrl.query.p;
		txCtx.querySpec = {
			props: ((propsParam && propsParam.split(',')) || [ '*' ]),
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
				let readDBO;
				try {
					readDBO = this._dboFactory.buildFetch(
						this._recordTypeName, txCtx.querySpec);
				} catch (err) {
					if (err instanceof common.X2SyntaxError) {
						this._log('invalid query string: ' + err.message);
						return Promise.reject(ws.createResponse(400).setEntity({
							errorCode: 'X2-RSRC-400-6',
							errorMessage: 'Invalid query string.'
						}));
					}
					return Promise.reject(err);
				}

				// assemble transaction phases
				const txPhases = new Array();

				// custom "before" hook
				if ((typeof this.beforeRead) === 'function')
					txPhases.push(
						(_, txCtx) => this.beforeRead(txCtx));

				// main action
				txPhases.push(
					(tx, txCtx) => readDBO.execute(
						tx, call.actor, txCtx.queryParams).then(
							result => {
								if (result.records.length === 0)
									return Promise.reject(
										ws.createResponse(404).setEntity({
											errorCode: 'X2-RSRC-404-1',
											errorMessage: 'Record not found.'
										})
									);
								return result.records[0];
							},
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

		// return the response promise
		return responsePromise;
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
				this._log('invalid patch document: ' + err.message);
				return ws.createResponse(400).setEntity({
					errorCode: 'X2-RSRC-400-5',
					errorMessage: 'Invalid patch document.'
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
				const idPropName = this._recordTypeDesc.idPropertyName;
				const recordFetchDBO = this._dboFactory.buildFetch(
					this._recordTypeName, {
						filter: [ [ idPropName, dbos.param('id') ] ]
					});

				// assemble transaction phases
				const txPhases = new Array();

				// custom "before" hook
				if ((typeof this.beforeUpdate) === 'function')
					txPhases.push(
						(_, txCtx) => this.beforeUpdate(txCtx));

				// main action
				txPhases.push(
					(tx, txCtx) => updateDBO.execute(
						tx, call.actor,
						record => {
							const errors = validators.normalizeRecord(
								this._recordTypes,
								this._recordTypeName,
								record,
								call.httpRequest.headers['Accept-Language'],
								'onUpdate'
							);
							if (errors)
								return Promise.reject(errors);
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
							err => {
								if (validators.isValidationErrors(err))
									return Promise.reject(
										ws.createResponse(422).setEntity({
											errorCode: 'X2-RSRC-422-1',
											errorMessage: 'Patch results in' +
												' invalid record data.',
											validationErrors: err
										}));
								return Promise.reject(err);
							}
						));

				// re-read updated record from the database if configured
				if (responseType === 'reread')
					txPhases.push(
						(tx, txCtx, record) => {
							return recordFetchDBO.execute(
								tx, call.actor, {
									id: record[idPropName]
								});
						});

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

		// prepare the response
		switch (responseType) {

		case 'nocontent':
			responsePromise = responsePromise.then(
				() => null, // 204 response
				err => Promise.reject(err)
			);
			break;

		default: // updated record in the response
			responsePromise = responsePromise.then(
				record => ws.createResponse(200)
					.setHeader('Content-Location', call.requestUrl.pathname)
					.setEntity(record),
				err => Promise.reject(err)
			);
		}

		// return the response promise
		return responsePromise;
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
				const deleteDBO = this._dboFactory.buildDelete(
					this._recordTypeName, txCtx.selectionFilter);

				// assemble transaction phases
				const txPhases = new Array();

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

	/**
	 * Create filter specification for the addressed record.
	 *
	 * @private
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @param {Object.<string,*>} queryParams DBO query parameters to populate.
	 * @returns {Array} Filter specification for the DBO.
	 */
	_createFilter(call, queryParams) {

		const filter = new Array();

		filter.push([ this._recordTypeDesc.idPropertyName, dbos.param('id') ]);

		const idPropDesc = this._recordTypeDesc.getPropertyDesc(
			this._recordTypeDesc.idPropertyName);
		queryParams['id'] = (
			idPropDesc.scalarValueType === 'number' ?
				Number(call.uriParams[call.uriParams.length - 1]) :
				call.uriParams[call.uriParams.length - 1]
		);

		this._addUplinkFilters(call, -2, filter, queryParams);

		return filter;
	}
}

// export the class
module.exports = IndividualResourceHandler;
