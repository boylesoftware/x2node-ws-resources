'use strict';

const ws = require('x2node-ws');
const dbos = require('x2node-dbos');
const validators = require('x2node-validators');

const AbstractResourceHandler = require('./abstract-resource-handler.js');


/**
 * Standard collection resource web wervice endpoint handler.
 *
 * @memberof module:x2node-ws-resources
 * @inner
 * @extends module:x2node-ws~AbstractResourceHandler
 * @implements module:x2node-ws.Handler
 */
class CollectionResourceHandler extends AbstractResourceHandler {

	/**
	 * <strong>Note:</strong> The constructor is not accessible from the client
	 * code. Instances are created using module's
	 * [createCollectionResourceHandler()]{@link module:x2node-ws-resources.createCollectionResourceHandler}
	 * function.
	 *
	 * @protected
	 * @param {module:x2node-dbos.DataSource} ds Data source.
	 * @param {module:x2node-dbos~DBOFactory} dboFactory DBO factory.
	 * @param {string} rsrcPath Resource path.
	 * @param {Object} [options] Options.
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

		// parse query string
		const queryParams = new Object();
		const querySpec = this._parseQuery(call.requestUrl.query, queryParams);
		if (!querySpec)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-1',
				errorMessage: 'Invalid query string.'
			});

		// add uplink filters
		this._addUplinkFilters(call, -1, querySpec.filter, queryParams);

		// build the DBO
		const dbo = this._dboFactory.buildFetch(this._recordTypeName, querySpec);

		// execute the DBO
		return this._executeTransaction({
			action: tx => dbo.execute(tx, call.actor, queryParams)
		});
	}

	/**
	 * Parse URL query parameters into a query specification for the fetch DBO.
	 *
	 * @private
	 * @param {Object} urlQuery URL query parameters.
	 * @param {Object.<string,*>} queryParams Fetch query parameters to populate.
	 * @returns {Object} Fetch DBO query specification, or <code>null</code> if
	 * invalid URL query parameters.
	 */
	_parseQuery(urlQuery, queryParams) {

		// TODO: implement
		return {
			props: [ '*' ],
			filter: []
		};
	}

	// process POST call
	POST(call) {

		// make sure that we have the entity
		const record = call.entity;
		if (!record)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-2',
				errorMessage: 'Expected record data in the request entity.'
			});

		// validate the record data
		const errors = validators.normalizeRecord(
			this._dboFactory.recordTypes, this._recordTypeName, record,
			call.httpRequest.headers['Accept-Language'], 'onCreate');
		if (errors)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-3',
				errorMessage: 'Invalid record data.',
				validationErrors: errors
			});

		// build the DBOs
		const insertDBO = this._dboFactory.buildInsert(
			this._recordTypeName, record);
		const idPropName = this._recordTypeDesc.idPropertyName;
		const fetchDBO = this._dboFactory.buildFetch(this._recordTypeName, {
			filter: [ [ idPropName, dbos.param('id') ] ]
		});

		// execute the DBOs and return the result
		return this._executeTransaction({
			action: tx => insertDBO.execute(tx, call.actor),
			afterAction: (tx, recordId) => fetchDBO.execute(tx, call.actor, {
				id: recordId
			})
		}).then(
			result => ws.createResponse(201)
				.setHeader(
					'Location', call.requestUrl.pathname + '/' +
						encodeURIComponent(result.records[0][idPropName]))
				.setEntity(result.records[0]),
			err => Promise.reject(err)
		);
	}
}

// export the class
module.exports = CollectionResourceHandler;
