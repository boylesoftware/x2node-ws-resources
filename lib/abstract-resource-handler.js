'use strict';

const common = require('x2node-common');
const ws = require('x2node-ws');
const dbos = require('x2node-dbos');

const TransactionContext = require('./transaction-context.js');


/**
 * Options object sections for different methods.
 *
 * @private
 * @constant {Array.<string>}
 */
const METHOD_OPTIONS = [
	'get', 'post', 'patch', 'put', 'delete'
];

// symbols used to store  stuff on the transaction context
const RESPONSE_ETAG = Symbol('ETag');
const RESPONSE_LASTMODIFIED = Symbol('Last-Modified');


/**
 * Abstract parent for standard resource web wervice endpoint handlers.
 *
 * @memberof module:x2node-ws-resources
 * @inner
 */
class AbstractResourceHandler {

	/**
	 * Create new handler.
	 *
	 * @protected
	 * @param {module:x2node-dbos.DataSource} ds Data source.
	 * @param {module:x2node-dbos~DBOFactory} dboFactory DBO factory.
	 * @param {string} rsrcPath Resource path specification.
	 * @param {Object} [options] Options.
	 * @throws {common.X2UsageError} If the resource path is invalid.
	 */
	constructor(ds, dboFactory, rsrcPath, options) {

		/**
		 * Debug logger.
		 *
		 * @member {function} module:x2node-ws-resources~AbstractResourceHandler#_log
		 */
		this._log = common.getDebugLogger('X2_APP');

		/**
		 * Options. Always present, always has sections for the methods.
		 *
		 * @member {Object} module:x2node-ws-resources~AbstractResourceHandler#_options
		 */
		this._options = (options || new Object());
		for (let section of METHOD_OPTIONS) {
			if (!this._options[section])
				this._options[section] = new Object();
		}

		/**
		 * The data source.
		 *
		 * @member {module:x2node-dbos.DataSource} module:x2node-ws-resources~AbstractResourceHandler#_ds
		 */
		this._ds = ds;

		/**
		 * The DBO factory.
		 *
		 * @member {module:x2node-dbos~DBOFactory} module:x2node-ws-resources~AbstractResourceHandler#_dboFactory
		 */
		this._dboFactory = dboFactory;

		const rsrcPathParts = rsrcPath.split('<-');
		/**
		 * Record type name.
		 *
		 * @member {string} module:x2node-ws-resources~AbstractResourceHandler#_recordTypeName
		 */
		this._recordTypeName = rsrcPathParts[rsrcPathParts.length - 1];

		/**
		 * Record types library.
		 *
		 * @member {module:x2node-records~RecordTypesLibrary} module:x2node-ws-resources~AbstractResourceHandler#_recordTypes
		 */
		this._recordTypes = dboFactory.recordTypes;

		/**
		 * Record type descriptor.
		 *
		 * @member {module:x2node-records~RecordTypeDescriptor} module:x2node-ws-resources~AbstractResourceHandler#_recordTypeDesc
		 */
		this._recordTypeDesc = this._recordTypes.getRecordTypeDesc(
			this._recordTypeName);

		/**
		 * Resource path uplink chain.
		 *
		 * @protected
		 * @member {Array.<Object>}
		 */
		this._uplinkChain = new Array();
		let recordTypeDesc = this._recordTypeDesc, uplinkPropPath = '';
		let uriParamOffset = 0;
		for (let i = rsrcPathParts.length - 2; i >= 0; i--) {
			const uplinkRef = rsrcPathParts[i];
			const uplinkRefParts = uplinkRef.split('.');
			for (let j = 0, len = uplinkRefParts.length; j < len; j++) {
				const uplinkPropName = uplinkRefParts[j];

				if (uplinkPropPath.length > 0)
					uplinkPropPath += '.';
				uplinkPropPath += uplinkPropName;

				const uplinkPropDesc = recordTypeDesc.getPropertyDesc(
					uplinkPropName);
				if (!uplinkPropDesc.isRef() || !uplinkPropDesc.isScalar() ||
					uplinkPropDesc.reverseRefPropertyName ||
					uplinkPropDesc.modifiable)
					throw new common.X2UsageError(
						`Uplink property ${uplinkPropPath} is not a stored,` +
							` non-modifiable, scalar reference.`);
				const uplinkRecordTypeDesc = uplinkPropDesc.nestedProperties;

				let uplinkValueFunc;
				if (j === len - 1) {
					const uplinkIdPropDesc =
						uplinkRecordTypeDesc.getPropertyDesc(
							uplinkRecordTypeDesc.idPropertyName);
					if (uplinkIdPropDesc.scalarValueType === 'number')
						uplinkValueFunc = function(v) { return Number(v); };
					else
						uplinkValueFunc = function(v) { return v; };
				}

				this._uplinkChain.push({
					propPath: uplinkPropPath,
					recordTypeDesc: uplinkRecordTypeDesc,
					uriParamOffset: (j === len - 1 ? uriParamOffset-- : null),
					value: uplinkValueFunc
				});

				recordTypeDesc = uplinkRecordTypeDesc;
			}
		}

		// build record version information properties descriptor
		const videsc = {
			versionProps: new Array(),
			versionPropName:
				this._recordTypeDesc.getRecordMetaInfoPropName('version'),
			lastModifiedPropName:
				this._recordTypeDesc.getRecordMetaInfoPropName(
					'modificationTimestamp')
		};
		if (videsc.versionPropName) {
			videsc.versionProps.push(videsc.versionPropName);
			videsc.versionPropDesc = this._recordTypeDesc.getPropertyDesc(
				videsc.versionPropName);
		}
		if (videsc.lastModifiedPropName) {
			videsc.versionProps.push(videsc.lastModifiedPropName);
			videsc.lastModifiedPropDesc = this._recordTypeDesc.getPropertyDesc(
				videsc.lastModifiedPropName);
		}
		if (videsc.versionProps.length > 0)
			videsc.versionInfoFetchDBO = this._dboFactory.buildFetch(
				this._recordTypeName, {
					props: videsc.versionProps,
					filter: [
						[ this._recordTypeDesc.idPropertyName, dbos.param('id') ]
					]
				});
		/**
		 * Record version information properties descriptor.
		 *
		 * @protected
		 * @member {Object}
		 */
		this._recordVersionInfoDesc = videsc;

		// configure handler extension
		if ((typeof this.configure) === 'function')
			this.configure();
	}

	/**
	 * Add uplink filters to the provided filters list.
	 *
	 * @protected
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @param {number} lastUplinkParamInd Index of the last uplink URI parameter
	 * from the end (-1 is for the last URI param, -2 is for the one before the
	 * last, etc.).
	 * @param {Array} filters The filters list to add to.
	 * @param {Object.<string,*>} queryParams Query parameters object.
	 * @returns {Array} The filters list passed into the method.
	 */
	_addUplinkFilters(call, lastUplinkParamInd, filters, queryParams) {

		const uriParams = call.uriParams;
		lastUplinkParamInd += uriParams.length;
		for (let uplink of this._uplinkChain) {
			if (uplink.uriParamOffset !== null) {
				const uriParamInd = lastUplinkParamInd + uplink.uriParamOffset;
				const paramName = 'uri' + uriParamInd;
				queryParams[paramName] = uplink.value(uriParams[uriParamInd]);
				filters.push([ uplink.propPath, dbos.param(paramName) ]);
			}
		}

		return filters;
	}

	/**
	 * Create new transaction context object.
	 *
	 * @protected
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @returns {module:x2node-ws-resources~TransactionContext} New context.
	 */
	_createTransactionContext(call) {

		return new TransactionContext(call, this._dboFactory);
	}

	/**
	 * Transaction phase function.
	 *
	 * @callback module:x2node-ws-resources~AbstractResourceHandler~transactionPhase
	 * @param {module:x2node-dbos~Transaction} tx The active transaction.
	 * @param {module:x2node-ws-resources~TransactionContext} txCtx Transaction
	 * context.
	 * @param {*} [result] Resolved result of the previous phase.
	 * @returns {Promise} Phase result promise. If resolved, the transaction
	 * proceeds to the next phase. The last phase's result is the handler
	 * response. If rejected, no subsequent phases are executed, the transaction
	 * is rolled back (unless explicitely committed by the phase) and the handler
	 * call is rejected with the phase's rejection object.
	 */

	/**
	 * Execute handler action in a transaction.
	 *
	 * @protected
	 * @param {module:x2node-ws-resources~TransactionContext} txCtx Transaction
	 * context.
	 * @param {Array.<module:x2node-ws-resources~AbstractResourceHandler~transactionPhase>} phases
	 * Transaction phases.
	 * @returns {Promise} Promise of the transaction result.
	 */
	_executeTransaction(txCtx, phases) {

		// acquire database connection
		let promiseChain = this._ds.getConnection().then(

			// got database connection, start transaction
			con => (txCtx._tx = this._dboFactory.newTransaction(con)).start()
		);

		// queue up transaction phases
		for (let phase of phases) {
			promiseChain = promiseChain.then(
				result => {

					// skip the rest of the phases if transaction is complete
					if (txCtx.complete)
						return result;

					// execute the phase
					return phase(txCtx._tx, txCtx, result);
				}
			);
		}

		// commit transaction and release the database connection
		promiseChain = promiseChain.then(
			result => txCtx._tx.commit(result)
		).then(
			result => {
				this._ds.releaseConnection(txCtx._tx.connection);
				delete txCtx._tx;
				txCtx.emit('commit');
				return result;
			}
		);

		// process transaction rejection
		promiseChain = promiseChain.catch(err => {

			// check if happened after transaction was created
			if (txCtx._tx) {

				// get database connection from the transaction
				const con = txCtx._tx.connection;

				// check if happened when the transaction was active
				if (txCtx._tx.isActive())

					// rollback transaction and then release the connection
					return txCtx._tx.rollback(err).catch(err => err).then(
						err => {

							// clear transaction from the context
							delete txCtx._tx;

							// release the database connection
							if (err instanceof Error)
								this._ds.releaseConnection(con, err);
							else
								this._ds.releaseConnection(con);

							// call the rollback listeners
							txCtx.emit('rollback');

							// return the rejection
							return Promise.reject(err);
						}
					);

				// clear transaction from the context
				delete txCtx._tx;

				// close the database connection
				if (err instanceof Error)
					this._ds.releaseConnection(con, err);
				else
					this._ds.releaseConnection(con);

				// call the rollback listeners
				txCtx.emit('rollback');
			}

			// return the rejection
			return Promise.reject(err);
		});

		// return the promise chain
		return promiseChain;
	}

	/**
	 * Tell if conditional HTTP request.
	 *
	 * @protected
	 * @param {module:x2node-ws.ServiceCall} call The call.
	 * @returns {boolean} <code>true</code> if has conditional headers.
	 */
	_isConditionalRequest(call) {

		const requestHeaders = call.httpRequest.headers;
		for (let h of [
			'if-match', 'if-unmodified-since', 'if-none-match',
			'if-modified-since',
		]) {
			if (requestHeaders[h])
				return true;
		}

		return false;
	}

	/**
	 * Evaluate preconditions in a conditional HTTP request.
	 *
	 * @protected
	 * @param {module:x2node-ws.ServiceCall} call The call.
	 * @param {string} [etag] The matching ETag, if any.
	 * @param {Date} [lastModified] The mathing last modification timestamp, if
	 * any.
	 * @returns {module:x2node-ws.ServiceResponse} Service response if execution
	 * of the call can/must be stoped, or nothing if it needs to continue.
	 */
	_evaluatePreconditions(call, etag, lastModified) {

		const requestHeaders = call.httpRequest.headers;
		let val;
		if ((val = requestHeaders['if-match']) !== undefined) {
			if (!this._matchETag(val, etag, false))
				return ws.createResponse(412).setEntity({
					errorCode: 'X2-RSRC-412-1',
					errorMessage: 'If-Match precondition failed.'
				});
		} else if ((val = requestHeaders['if-unmodified-since']) !== undefined) {
			const date = (new Date(val)).getTime();
			if (!Number.isNaN(date) &&
				(!lastModified || lastModified.getTime() > date))
				return ws.createResponse(412).setEntity({
					errorCode: 'X2-RSRC-412-2',
					errorMessage: 'If-Unmodified-Since precondition failed.'
				});
		}
		const httpMethod = call.httpRequest.method;
		if ((val = requestHeaders['if-none-match']) !== undefined) {
			if (this._matchETag(val, etag, true)) {
				if ((httpMethod === 'GET') || (httpMethod === 'HEAD')) {
					const response = ws.createResponse(304);
					response.setHeader('ETag', etag);
					if (lastModified)
						response.setHeader('Last-Modified', lastModified);
					return response;
				}
				return ws.createResponse(412).setEntity({
					errorCode: 'X2-RSRC-412-3',
					errorMessage: 'If-None-Match precondition failed.'
				});
			}
		} else if ((val = requestHeaders['if-modified-since']) !== undefined) {
			if ((httpMethod === 'GET') || (httpMethod === 'HEAD')) {
				const date = (new Date(val)).getTime();
				if (!Number.isNaN(date) && lastModified &&
					(lastModified.getTime() > date)) {
					const response = ws.createResponse(304);
					if (etag)
						response.setHeader('ETag', etag);
					response.setHeader('Last-Modified', lastModified);
					return response;
				}
			}
		}
	}

	/**
	 * Match ETag against the "If-Match" or "If-None-Match" header value.
	 *
	 * @private
	 * @param {string} val The conditional header value.
	 * @param {string} [etag] The ETag.
	 * @param {boolean} useWeak <code>true</code> to use weak comparison instead
	 * of strong.
	 */
	_matchETag(val, etag, useWeak) {

		if (val === '*')
			return true;

		if (!etag)
			return false;

		for (let valEl of val.split(/\s*,\s*/g)) {
			if (valEl === etag)
				return true;
			if (useWeak && valEl.startsWith('W/') &&
				(valEl.substring(2) === etag))
				return true;
		}

		return false;
	}

	/**
	 * Get record version information for the "ETag" and "Last-Modified" headers.
	 *
	 * @protected
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @param {Object} rec The record.
	 * @returns {Object} Record version information object.
	 */
	_getRecordVersionInfo(call, rec) {

		const videsc = this._recordVersionInfoDesc;
		return {
			etag: (
				videsc.versionPropName && (
					'"' + call.apiVersion +
						':' + String(call.actor ? call.actor.id : '*') +
						':' + rec[videsc.versionPropName] + '"'
				)
			),
			lastModified: (
				videsc.lastModifiedPropName && new Date(
					rec[videsc.lastModifiedPropName] ||
						'1970-01-01T00:00:00.000Z')
			)
		};
	}

	/**
	 * Save values for "ETag" and "Last-Modified" headers for later use by the
	 * [_addValidatorHeaders()]{@link module:x2node-ws-resources~AbstractResourceHandler#_addValidatorHeaders}
	 * method.
	 *
	 * @protected
	 * @param {module:x2node-ws-resources~TransactionContext} txCtx Transaction
	 * context.
	 * @param {string} [etag] "ETag" value to save.
	 * @param {Date} [lastModified] "Last-Modified" value to save.
	 */
	_saveValidatorHeaders(txCtx, etag, lastModified) {

		if (etag)
			txCtx[RESPONSE_ETAG] = etag;

		if (lastModified)
			txCtx[RESPONSE_LASTMODIFIED] = lastModified;
	}

	/**
	 * Add "ETag" and "Last-Modified" headers to the response if the values are
	 * present on the transaction context.
	 *
	 * @protected
	 * @param {module:x2node-ws-resources~TransactionContext} txCtx Transaction
	 * context.
	 * @param {module:x2node-ws~ServiceResponse} response The response.
	 * @returns {module:x2node-ws~ServiceResponse} The response.
	 */
	_addValidatorHeaders(txCtx, response) {

		let val = txCtx[RESPONSE_ETAG];
		if (val)
			response.setHeader('ETag', val);

		val = txCtx[RESPONSE_LASTMODIFIED];
		if (val)
			response.setHeader('Last-Modified', val);

		return response;
	}
}

// export the class
module.exports = AbstractResourceHandler;
