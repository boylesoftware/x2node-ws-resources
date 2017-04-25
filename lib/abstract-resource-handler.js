'use strict';

const common = require('x2node-common');
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

/**
 * Abstract parent for standard resource web wervice endpoint handlers.
 *
 * @protected
 * @memberof module:x2node-ws-resources
 * @inner
 */
class AbstractResourceHandler {

	/**
	 * Create new handler.
	 *
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
		 * @protected
		 * @member {function}
		 */
		this._log = common.getDebugLogger('X2_APP');

		/**
		 * Options. Always present, always has sections for the methods.
		 *
		 * @protected
		 * @member {Object}
		 */
		this._options = (options || new Object());
		for (let section of METHOD_OPTIONS) {
			if (!this._options[section])
				this._options[section] = new Object();
		}

		/**
		 * The data source.
		 *
		 * @protected
		 * @member {module:x2node-dbos.DataSource}
		 */
		this._ds = ds;

		/**
		 * The DBO factory.
		 *
		 * @protected
		 * @member {module:x2node-dbos~DBOFactory}
		 */
		this._dboFactory = dboFactory;

		const rsrcPathParts = rsrcPath.split('<-');
		/**
		 * Record type name.
		 *
		 * @protected
		 * @member {string}
		 */
		this._recordTypeName = rsrcPathParts[rsrcPathParts.length - 1];

		/**
		 * Record types library.
		 *
		 * @protected
		 * @member {module:x2node-records~RecordTypesLibrary}
		 */
		this._recordTypes = dboFactory.recordTypes;

		/**
		 * Record type descriptor.
		 *
		 * @protected
		 * @member {module:x2node-records~RecordTypeDescriptor}
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

		// get connection, organize transaction and execute the phases
		return this._ds.getConnection().then(
			con => {
				const tx = this._dboFactory.newTransaction(con);
				return tx.start().then(

					// execute transaction phases
					() => {

						// add transaction to the context
						txCtx._tx = tx;

						// phases promise chain
						let promiseChain = Promise.resolve();

						// queue up the phases
						for (let phase of phases) {
							promiseChain = promiseChain.then(
								result => {
									try {
										return phase(tx, txCtx, result);
									} catch (err) {
										return Promise.reject(err);
									}
								},
								err => Promise.reject(err)
							);
						}

						// return the chain
						return promiseChain;
					},

					// transaction start error
					err => Promise.reject(err)

				).then( // commit or rollback transaction
					result => tx.commit(result),
					err => (
						tx.isActive() ?
							tx.rollback(Promise.reject(err)) :
							Promise.reject(err)
					)

				).then( // close connection and return the result
					result => {
						delete txCtx._tx;
						this._ds.releaseConnection(con);
						return result;
					},
					err => {
						delete txCtx._tx;
						if (err instanceof Error)
							this._ds.releaseConnection(con, err);
						else
							this._ds.releaseConnection(con);
						return Promise.reject(err);
					}
				);
			},

			// database connection acquision error
			err => Promise.reject(err)
		);
	}
}

// export the class
module.exports = AbstractResourceHandler;
