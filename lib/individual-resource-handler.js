'use strict';

const common = require('x2node-common');
const ws = require('x2node-ws');
const dbos = require('x2node-dbos');
const validators = require('x2node-validators');
const patches = require('x2node-patches');

const AbstractResourceHandler = require('./abstract-resource-handler.js');


// TODO: cache DBOs
// TODO: support PUT for assigned id records

/**
 * Standard individual resource web wervice endpoint handler.
 *
 * @memberof module:x2node-ws-resources
 * @inner
 * @extends module:x2node-ws~AbstractResourceHandler
 * @implements module:x2node-ws.Handler
 */
class IndividualResourceHandler extends AbstractResourceHandler {

	/**
	 * <strong>Note:</strong> The constructor is not accessible from the client
	 * code. Instances are created using module's
	 * [createIndividualResourceHandler()]{@link module:x2node-ws-resources.createIndividualResourceHandler}
	 * function.
	 *
	 * @protected
	 * @param {module:x2node-dbos.DataSource} ds Data source.
	 * @param {module:x2node-dbos~DBOFactory} dboFactory DBO factory.
	 * @param {string} rsrcPath Resource path.
	 * @param {Object} [options] Options.
	 */
	constructor(ds, dboFactory, rsrcPath, options) {
		super(ds, dboFactory, rsrcPath, options);
	}

	// call permissions checker
	isAllowed(call) {

		// TODO: implement ACLs
		return true;
	}

	// process GET call
	GET(call) {

		// create query specification
		const queryParams = new Object();
		const propsParam = call.requestUrl.query.p;
		const querySpec = {
			props: ((propsParam && propsParam.split(',')) || [ '*' ]),
			filter: this._createFilter(call, queryParams)
		};

		// build the DBO
		let dbo;
		try {
			dbo = this._dboFactory.buildFetch(this._recordTypeName, querySpec);
		} catch (err) {
			if (err instanceof common.X2SyntaxError) {
				this._log('invalid query string: ' + err.message);
				return ws.createResponse(400).setEntity({
					errorCode: 'X2-RSRC-400-6',
					errorMessage: 'Invalid query string.'
				});
			}
			throw err;
		}

		// execute the DBO in a transaction, prepare response and return it
		return this._executeTransaction({
			action: tx => dbo.execute(tx, call.actor, queryParams)
		}).then(
			result => {
				if (result.records.length === 0)
					return ws.createResponse(404).setEntity({
						errorCode: 'X2-RSRC-404-1',
						errorMessage: 'Record not found.'
					});
				return result.records[0];
			},
			err => Promise.reject(err)
		);
	}

	// process PATCH call
	PATCH(call) {

		// make sure that we have the entity
		const patchSpec = call.entity;
		if (!patchSpec)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-4',
				errorMessage: 'Expected patch document in the request body.'
			});

		// build the patch depending on the format
		let patch;
		try {
			switch (call.entityContentType) {
			case 'application/json-patch+json':
				patch = patches.build(
					this._dboFactory.recordTypes, this._recordTypeName,
					patchSpec);
				break;
			case 'application/merge-patch+json':
				patch = patches.buildMerge(
					this._dboFactory.recordTypes, this._recordTypeName,
					patchSpec);
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
		if (!patch) {
			return ws.createResponse(415)
				.setHeader(
					'Accept-Patch',
					'application/json-patch+json, application/merge-patch+json')
				.setEntity({
					errorCode: 'X2-RSRC-415-1',
					errorMessage: 'Unsupported patch document format.'
				});
		}

		// build the update DBO
		const queryParams = new Object();
		const updateDBO = this._dboFactory.buildUpdate(
			this._recordTypeName, patch,
			this._createFilter(call, queryParams));

		// build transaction:

		// main action
		const txPhases = {
			action: tx => updateDBO.execute(
				tx, call.actor, record => {
					const errors = validators.normalizeRecord(
						this._dboFactory.recordTypes, this._recordTypeName,
						record, call.httpRequest.headers['Accept-Language'],
						'onUpdate');
					if (errors)
						return Promise.reject(errors);
				}, queryParams)
		};

		// re-read updated record from the database if configured
		const responseType = this._options.patch.response;
		if (responseType === 'reread') {

			// build record fetch DBO
			const idPropName = this._recordTypeDesc.idPropertyName;
			const recordFetchDBO = this._dboFactory.buildFetch(
				this._recordTypeName, {
					filter: [ [ idPropName, dbos.param('id') ] ]
				});

			// add after-action
			txPhases.afterAction = (tx, result) => {
				if (result.recordsUpdated === 0)
					return result;
				return recordFetchDBO.execute(
					tx, call.actor, {
						id: result.records[0][idPropName]
					});
			}
		}

		// execute the transaction
		let responsePromise = this._executeTransaction(txPhases).then(
			result => {
				if (result.records.length === 0)
					return Promise.reject(ws.createResponse(404).setEntity({
						errorCode: 'X2-RSRC-404-1',
						errorMessage: 'Record not found.'
					}));
				return result.records[0];
			},
			err => {
				if (validators.isValidationErrors(err))
					return Promise.reject(ws.createResponse(422).setEntity({
						errorCode: 'X2-RSRC-422-1',
						errorMessage: 'Patch results in invalid record data.',
						validationErrors: err
					}));
				return Promise.reject(err);
			}
		);

		// prepare the result
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

	// process DELETE call
	DELETE(call) {

		// TODO: check existence of weakly dependent records

		// build the DBO
		const queryParams = new Object();
		const dbo = this._dboFactory.buildDelete(
			this._recordTypeName, this._createFilter(call, queryParams));

		// execute the DBO in a transaction, prepare response and return it
		return this._executeTransaction({
			action: tx => dbo.execute(tx, call.actor, queryParams)
		}).then(
			result => {
				if (result[this._recordTypeName] > 0)
					return ws.createResponse(204);
				return ws.createResponse(404).setEntity({
					errorCode: 'X2-RSRC-404-1',
					errorMessage: 'Record not found.'
				});
			},
			err => Promise.reject(err)
		);
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
