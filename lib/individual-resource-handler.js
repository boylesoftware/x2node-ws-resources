'use strict';

const common = require('x2node-common');
const ws = require('x2node-ws');
const dbos = require('x2node-dbos');
const validators = require('x2node-validators');

const AbstractResourceHandler = require('./abstract-resource-handler.js');


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
	 */
	constructor(ds, dboFactory, rsrcPath, options) {
		super(ds, dboFactory, rsrcPath);

		this._options = options;
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
		const querySpec = {
			props: (queryParams.p || '*'),
			filter: this._createFilter(call, queryParams)
		};

		// build the DBO
		const dbo = this._dboFactory.buildFetch(this._recordTypeName, querySpec);

		// execute the DBO
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
		const patch = call.entity;
		if (!patch)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-4',
				errorMessage: 'Expected patch document in the request body.'
			});

		// TODO: support JSON Merge Patch
		// validate patch format
		if (call.entityContentType !== 'application/json-patch+json')
			return ws.createResponse(415)
				.setHeader('Accept-Patch', 'application/json-patch+json')
				.setEntity({
					errorCode: 'X2-RSRC-415-1',
					errorMessage: 'Unsupported patch document format.'
				});

		// build the DBO
		const queryParams = new Object();
		let dbo;
		try {
			dbo = this._dboFactory.buildUpdate(
				this._recordTypeName, patch,
				this._createFilter(call, queryParams));
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

		// execute the DBO
		return this._executeTransaction({
			action: tx => dbo.execute(
				tx, call.actor, record => {
					const errors = validators.normalizeRecord(
						this._dboFactory.recordTypes, this._recordTypeName,
						record, call.httpRequest.headers['Accept-Language'],
						'onUpdate');
					if (errors)
						return Promise.reject(errors);
				}, queryParams)
		}).then(
			result => {
				if (result.records.length === 0)
					return ws.createResponse(404).setEntity({
						errorCode: 'X2-RSRC-404-1',
						errorMessage: 'Record not found.'
					});
				return result.records[0];
			},
			err => {
				if (validators.isValidationErrors(err))
					return ws.createResponse(422).setEntity({
						errorCode: 'X2-RSRC-422-1',
						errorMessage: 'Patch results in invalid record data.',
						validationErrors: err
					});
				return Promise.reject(err);
			}
		);
	}

	// process DELETE call
	DELETE(call) {

		// build the DBO
		const queryParams = new Object();
		const dbo = this._dboFactory.buildDelete(
			this._recordTypeName, this._createFilter(call, queryParams));

		// execute the DBO
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
			this._recordTypeDesc.idPropertyName);;
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
