'use strict';

const common = require('x2node-common');
const ws = require('x2node-ws');
const dbos = require('x2node-dbos');
const validators = require('x2node-validators');

const AbstractResourceHandler = require('./abstract-resource-handler.js');
const searchQueryParser = require('./search-query-parser.js');


/**
 * Standard collection resource web wervice endpoint handler.
 *
 * @memberof module:x2node-ws-resources
 * @extends module:x2node-ws-resources~AbstractResourceHandler
 * @implements module:x2node-ws.Handler
 */
class CollectionResourceHandler extends AbstractResourceHandler {

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

		// reusable DBO for fetching new record after POST
		this._newRecordFetchDBO = dboFactory.buildFetch(
			this._recordTypeName, {
				filter: [
					[ this._recordTypeDesc.idPropertyName, dbos.param('id') ]
				]
			});
	}

	/**
	 * Enable bulk update operation by allowing <code>PATCH</code> method for the
	 * collection. Can be called from the handler extension's
	 * <code>configure()</code> method.
	 */
	enableBulkUpdate() {

		this.PATCH = this._BULK_PATCH;
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
			action = 'search';
			break;
		case 'POST':
			action = 'create';
		}

		return this.isAllowedAction(action, call.actor, call);
	}

	/////////////////////////////////////////////////////////////////////////////
	// process GET call
	/////////////////////////////////////////////////////////////////////////////
	GET(call) {

		// transaction context
		const txCtx = this._createTransactionContext(call);

		// create query specification
		txCtx.queryParams = new Object();
		try {

			// parse query string
			txCtx.querySpec = searchQueryParser.parseSearchQuery(
				this._recordTypeDesc, call.requestUrl.query, 'pfor',
				txCtx.queryParams);

			// add uplink filters
			this._addUplinkFilters(
				call, -1, txCtx.querySpec.filter, txCtx.queryParams);

		} catch (err) {
			if (err instanceof common.X2SyntaxError) {
				return ws.createResponse(400).setEntity({
					errorCode: 'X2-RSRC-400-1',
					errorMessage: 'Invalid query string: ' + err.message
				});
			}
			throw err;
		}

		// pre-resolve response promise
		let responsePromise = Promise.resolve();

		// custom preparation logic
		if ((typeof this.prepareSearch) === 'function')
			responsePromise = responsePromise.then(
				() => Promise.resolve(this.prepareSearch(txCtx))
			);

		// proceed to the transaction
		responsePromise = responsePromise.then(() => {

			// build search DBO
			// TODO: cache search DBO
			let searchDBO;
			try {
				searchDBO = this._dboFactory.buildFetch(
					this._recordTypeName, txCtx.querySpec);
			} catch (err) {
				if (err instanceof common.X2SyntaxError) {
					return Promise.reject(ws.createResponse(400).setEntity({
						errorCode: 'X2-RSRC-400-1',
						errorMessage: 'Invalid query string: ' + err.message
					}));
				}
				return Promise.reject(err);
			}

			// assemble transaction phases
			const txPhases = new Array();

			// lock collections, process conditional request, calculate etag
			const rcMonitor = this._dboFactory.recordCollectionsMonitor;
			if (rcMonitor)
				txPhases.push(
					(_, txCtx) => rcMonitor.getCollectionsVersion(
						txCtx.transaction,
						searchDBO.involvedRecordTypeNames,
						'shared'
					).then(versionInfo => this._processConditionalRequest(
						txCtx, versionInfo
					))
				);

			// custom "before" hook
			if ((typeof this.beforeSearch) === 'function')
				txPhases.push((_, txCtx) => this.beforeSearch(txCtx));

			// main action
			txPhases.push((tx, txCtx) => searchDBO.execute(
				tx, call.actor, txCtx.queryParams).then(result => {
					// make sure record type name is in the result
					result.recordTypeName = this._recordTypeName;
					return result;
				}));

			// custom "after" hook
			if ((typeof this.afterSearch) === 'function')
				txPhases.push((_, txCtx, result) => this.afterSearch(
					txCtx, result));

			// execute the transaction
			return this._executeTransaction(txCtx, txPhases);
		});

		// custom completion logic
		if ((typeof this.completeSearch) === 'function')
			responsePromise = responsePromise.then(
				result => Promise.resolve(
					txCtx.complete ?
						result :
						this.completeSearch(undefined, txCtx, result)
				),
				err => Promise.reject(
					this.completeSearch(err, txCtx, undefined))
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

	/////////////////////////////////////////////////////////////////////////////
	// process POST call
	/////////////////////////////////////////////////////////////////////////////
	POST(call) {

		// transaction context
		const txCtx = this._createTransactionContext(call);
		txCtx.recordTmpl = call.entity;

		// make sure that we have the entity
		if (!txCtx.recordTmpl)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-2',
				errorMessage: 'Expected record data in the request entity.'
			});

		// pre-resolve response promise
		let responsePromise = Promise.resolve();

		// custom record template modification logic
		if ((typeof this.prepareCreateSpec) === 'function')
			responsePromise = responsePromise.then(() => Promise.resolve(
				this.prepareCreateSpec(txCtx, txCtx.recordTmpl)));

		// validate the record data
		responsePromise = responsePromise.then(() => {
			const errors = validators.normalizeRecord(
				this._recordTypes, this._recordTypeName, txCtx.recordTmpl,
				call.httpRequest.headers['Accept-Language'], 'onCreate');
			if (errors)
				return Promise.reject(ws.createResponse(400).setEntity({
					errorCode: 'X2-RSRC-400-3',
					errorMessage: 'Invalid record data.',
					validationErrors: errors
				}));
		});

		// build specification for the parent record fetch DBO
		if (this._uplinkChain.length > 0) {
			responsePromise = responsePromise.then(() => {
				txCtx.parentQueryParams = new Object();
				txCtx.parentQuerySpec = this._buildParentRecordFetchQuerySpec(
					call, txCtx.recordTmpl, txCtx.parentQueryParams);
			});
		}

		// lock the main records collection by default
		txCtx.lockCollections = [ this._recordTypeName ];

		// custom preparation logic
		if ((typeof this.prepareCreate) === 'function')
			responsePromise = responsePromise.then(() => Promise.resolve(
				this.prepareCreate(txCtx, txCtx.recordTmpl)));

		// validate immediate uplink value, if any
		if (this._uplinkChain.length > 0) {
			const uplink = this._uplinkChain[0];
			if (uplink.uriParamOffset !== null)
				responsePromise = responsePromise.then(() => {
					const expectedValue =
						uplink.recordTypeDesc.name + '#' +
						uplink.value(call.uriParams[call.uriParams.length - 1]);
					if (txCtx.recordTmpl[uplink.propPath] !== expectedValue)
						return Promise.reject(ws.createResponse(400).setEntity({
							errorCode: 'X2-RSRC-400-7',
							errorMessage:
								'Record data does not match the resource URI.'
						}));
				});
		}

		// proceed to the transaction
		const idPropName = this._recordTypeDesc.idPropertyName;
		const responseType = this._options.post.response;
		responsePromise = responsePromise.then(() => {

			// assemble transaction phases
			const txPhases = new Array();

			// lock collections for update, process conditional request
			const rcMonitor = this._dboFactory.recordCollectionsMonitor;
			if (rcMonitor)
				txPhases.push(
					(_, txCtx) => rcMonitor.getCollectionsVersion(
						txCtx.transaction,
						new Set(txCtx.lockCollections),
						'exclusive'
					).then(versionInfo => this._processConditionalRequest(
						txCtx, versionInfo
					))
				);

			// fetch the parent record, if any
			if (this._uplinkChain.length > 0)
				txPhases.push((tx, txCtx) => this._dboFactory.buildFetch(
					this._uplinkChain[0].recordTypeDesc.name,
					txCtx.parentQuerySpec
				).execute(
					tx, call.actor, txCtx.parentQueryParams
				).then(result => {
					const numRecs = result.records;
					if (numRecs.length > 1)
						return Promise.reject(new common.X2DataError(
							'More than one parent record.'));
					if (numRecs.length === 0)
						return tx.commit().then(() => Promise.reject(
							ws.createResponse(404).setEntity({
								errorCode: 'X2-RSRC-404-2',
								errorMessage: 'Parent record not found.'
							})
						));
					txCtx.parentRecord = result.records[0];
				}));

			// custom "before" hook
			if ((typeof this.beforeCreate) === 'function')
				txPhases.push((_, txCtx) => this.beforeCreate(
					txCtx, txCtx.recordTmpl));

			// create insert DBO and execute the main action
			txPhases.push(
				(tx, txCtx) => this._dboFactory.buildInsert(
					this._recordTypeName, txCtx.recordTmpl
				).execute(
					tx, call.actor
				)
			);

			// fetch the new record if configured
			if ((responseType === undefined) || (responseType === 'record'))
				txPhases.push(
					(tx, txCtx, recordId) => this._newRecordFetchDBO.execute(
						tx, call.actor, {
							id: recordId
						}).then(result => result.records[0])
				);
			else
				txPhases.push(
					(tx, txCtx, recordId) => {
						txCtx.recordTmpl[idPropName] = recordId;
						return Promise.resolve(txCtx.recordTmpl);
					}
				);

			// custom "after" hook
			if ((typeof this.afterCreate) === 'function')
				txPhases.push((_, txCtx, record) => this.afterCreate(
					txCtx, record));

			// execute the transaction
			return this._executeTransaction(txCtx, txPhases);
		});

		// custom completion logic
		if ((typeof this.completeCreate) === 'function')
			responsePromise = responsePromise.then(
				result => Promise.resolve(
					txCtx.complete ?
						result :
						this.completeCreate(undefined, txCtx, result)
				),
				err => Promise.reject(
					this.completeCreate(err, txCtx, undefined))
			);

		// prepare the response
		switch (responseType) {

		case 'status':
		case 'redirect':
			responsePromise = responsePromise.then(result => {
				if (txCtx.complete)
					return result;
				const location = call.requestUrl.pathname + '/' +
					encodeURIComponent(result[idPropName]);
				return ws.createResponse(responseType === 'redirect' ? 303 : 201)
					.setHeader('Location', location)
					.setEntity(Buffer.from(`<!DOCTYPE html>
<html lang="en">
  <head><title>${this._recordTypeName} Created</title></head>
  <body>Location: <a href="${location}">${location}</a></body>
<html>`, 'utf8'), 'text/html; charset=UTF-8');
			});

			break;

		default: // new record in the body
			responsePromise = responsePromise.then(result => {
				if (txCtx.complete)
					return result;
				const location = call.requestUrl.pathname + '/' +
					encodeURIComponent(result[idPropName]);
				const videsc = this._getRecordVersionInfo(call, result);
				this._saveValidatorHeaders(
					txCtx, videsc.etag, videsc.lastModified);
				return this._addValidatorHeaders(
					txCtx, ws.createResponse(201)
						.setHeader('Location', location)
						.setHeader('Content-Location', location)
						.setEntity(result));
			});
		}

		// return the response promise
		return responsePromise;
	}

	/**
	 * Build query specification for the fetch DBO that gets the parent record id
	 * based on the uplink URI parameters and used to check parent records
	 * existence.
	 *
	 * @private
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @param {Object} record The record.
	 * @param {Object.<string,*>} queryParams Query parameters object that is
	 * populated by this method.
	 * @returns {Object} Query specification for the fetch DBO.
	 */
	_buildParentRecordFetchQuerySpec(call, record, queryParams) {

		const filter = new Array();
		const uriParams = call.uriParams;
		const lastUplinkParamInd = uriParams.length - 1;
		for (let i = 0, len = this._uplinkChain.length; i < len; i++) {
			const uplink = this._uplinkChain[i];
			if ((uplink.uriParamOffset === null) && (i === 0)) {
				const idString = record[uplink.propPath].substring(
					uplink.recordTypeDesc.name.length + 1);
				const idPropDesc = uplink.recordTypeDesc.getPropertyDesc(
					uplink.recordTypeDesc.idPropertyName);
				queryParams['pid'] = (
					idPropDesc.scalarValueType === 'number' ?
						Number(idString) : idString);
				filter.push([
					uplink.recordTypeDesc.idPropertyName,
					dbos.param('pid')
				]);
			} else {
				const uriParamInd = lastUplinkParamInd + uplink.uriParamOffset;
				const paramName = 'uri' + uriParamInd;
				queryParams[paramName] = uplink.value(uriParams[uriParamInd]);
				filter.push([
					(
						i > 0 ?
							uplink.propPath.substring(
								uplink.propPath.indexOf('.') + 1) :
							uplink.recordTypeDesc.idPropertyName
					),
					dbos.param(paramName)
				]);
			}
		}

		return {
			props: [],
			filter: filter,
			lock: 'shared'
		};
	}

	/////////////////////////////////////////////////////////////////////////////
	// process bulk PATCH call
	/////////////////////////////////////////////////////////////////////////////
	_BULK_PATCH(call) {

		// transaction context
		const txCtx = this._createTransactionContext(call);
		txCtx.patchSpec = call.entity;

		// make sure that we have the entity
		if (!txCtx.patchSpec)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-4',
				errorMessage: 'Expected patch document in the request body.'
			});

		// create query specification
		txCtx.queryParams = new Object();
		try {

			// parse query string
			txCtx.querySpec = searchQueryParser.parseSearchQuery(
				this._recordTypeDesc, call.requestUrl.query, 'f',
				txCtx.queryParams);

			// make sure we have an explicit filter
			if (!txCtx.querySpec.filter || (txCtx.querySpec.filter.length === 0))
				return ws.createResponse(400).setEntity({
					errorCode: 'X2-RSRC-400-9',
					errorMessage: 'Explicit filter is required.'
				});

			// add uplink filters
			this._addUplinkFilters(
				call, -1, txCtx.querySpec.filter, txCtx.queryParams);

		} catch (err) {
			if (err instanceof common.X2SyntaxError) {
				return ws.createResponse(400).setEntity({
					errorCode: 'X2-RSRC-400-1',
					errorMessage: 'Invalid query string: ' + err.message
				});
			}
			throw err;
		}

		// pre-resolve response promise
		let responsePromise = Promise.resolve();

		// custom patch modification logic
		if ((typeof this.prepareBulkUpdateSpec) === 'function')
			responsePromise = responsePromise.then(() => Promise.resolve(
				this.prepareBulkUpdateSpec(txCtx, txCtx.patchSpec)));

		// build the patch
		responsePromise = responsePromise.then(() => this._buildPatch(txCtx));

		// lock the main records collection by default
		txCtx.lockCollections = [ this._recordTypeName ];

		// custom preparation logic
		if ((typeof this.prepareBulkUpdate) === 'function')
			responsePromise = responsePromise.then(
				() => Promise.resolve(this.prepareBulkUpdate(txCtx))
			);

		// proceed to the transaction
		responsePromise = responsePromise.then(() => {

			// build update DBO
			let updateDBO;
			try {
				updateDBO = this._dboFactory.buildUpdate(
					this._recordTypeName, txCtx.patch, txCtx.querySpec.filter);
			} catch (err) {
				if (err instanceof common.X2SyntaxError) {
					return Promise.reject(ws.createResponse(400).setEntity({
						errorCode: 'X2-RSRC-400-1',
						errorMessage: 'Invalid query string: ' + err.message
					}));
				}
				return Promise.reject(err);
			}

			// assemble transaction phases
			const txPhases = new Array();

			// lock collections, process conditional request
			const rcMonitor = this._dboFactory.recordCollectionsMonitor;
			if (rcMonitor)
				txPhases.push(
					(_, txCtx) => rcMonitor.getCollectionsVersion(
						txCtx.transaction,
						new Set(txCtx.lockCollections),
						'exclusive'
					).then(versionInfo => this._processConditionalRequest(
						txCtx, versionInfo
					))
				);

			// custom "before" hook
			if ((typeof this.beforeBulkUpdate) === 'function')
				txPhases.push((_, txCtx) => this.beforeBulkUpdate(txCtx));

			// main action
			txPhases.push((tx, txCtx) => updateDBO.execute(
				tx, call.actor, record => {
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
				}, txCtx.queryParams));

			// custom "after" hook
			if ((typeof this.afterBulkUpdate) === 'function')
				txPhases.push((_, txCtx, result) => this.afterBulkUpdate(
					txCtx, result));

			// execute the transaction
			return this._executeTransaction(txCtx, txPhases);
		});

		// custom completion logic
		if ((typeof this.completeBulkUpdate) === 'function')
			responsePromise = responsePromise.then(
				result => Promise.resolve(
					txCtx.complete ?
						result :
						this.completeBulkUpdate(undefined, txCtx, result)
				),
				err => Promise.reject(
					this.completeBulkUpdate(err, txCtx, undefined))
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

	/////////////////////////////////////////////////////////////////////////////
	// common methods
	/////////////////////////////////////////////////////////////////////////////

	/**
	 * Process conditional request and determine values for the "ETag" and
	 * "Last-Modified" HTTP response headers.
	 *
	 * @private
	 * @param {module:x2node-ws-resources~TransactionContext} txCtx Transaction
	 * context.
	 * @param {Object} versionInfo Version information object from the record
	 * collections monitor.
	 * @returns {*} Response to return immediately (the transaction is marked as
	 * complete), or nothing to proceed with the transaction.
	 */
	_processConditionalRequest(txCtx, versionInfo) {

		// get the ETag and Last-Modified
		const etag =
			'"' + txCtx.call.apiVersion +
			':' + String(txCtx.call.actor ? txCtx.call.actor.id : '*') +
			':' + versionInfo.version + '"';
		const lastModified = versionInfo.modifiedOn;

		// evaluate preconditions
		const response = this._evaluatePreconditions(
			txCtx.call, etag, lastModified);
		if (response) {
			txCtx.makeComplete();
			return response;
		}

		// set the ETag and Last-Modified on the transaction context
		this._saveValidatorHeaders(txCtx, etag, lastModified);
	}
}

// export the class
module.exports = CollectionResourceHandler;
