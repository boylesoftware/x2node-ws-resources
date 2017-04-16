'use strict';

const dbos = require('x2node-dbos');


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
	 */
	constructor(ds, dboFactory, rsrcPath) {

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

		const recordTypes = dboFactory.recordTypes;

		/**
		 * Record type descriptor.
		 *
		 * @protected
		 * @member {module:x2node-records~RecordTypeDescriptor}
		 */
		this._recordTypeDesc = recordTypes.getRecordTypeDesc(
			this._recordTypeName);

		/**
		 * Resource path uplink chain.
		 *
		 * @protected
		 * @member {Array.<Object>}
		 */
		this._uplinkChain = new Array();
		let recordTypeDesc = this._recordTypeDesc, uplinkPropPath = '';
		for (let i = rsrcPathParts.length - 2; i >= 0; i--) {
			const uplinkPropName = rsrcPathParts[i];
			if (uplinkPropPath.length > 0)
				uplinkPropPath += '.';
			uplinkPropPath += uplinkPropName;
			const uplinkPropDesc = recordTypeDesc.getPropertyDesc(
				uplinkPropName);
			const uplinkRecordTypeDesc = uplinkPropDesc.nestedProperties;
			const uplinkIdPropDesc = uplinkRecordTypeDesc.getPropertyDesc(
				uplinkRecordTypeDesc.idPropertyName);
			let uplinkValueFunc;
			if (uplinkIdPropDesc.scalarValueType === 'number')
				uplinkValueFunc = function(v) { return Number(v); };
			else
				uplinkValueFunc = function(v) { return v; };
			this._uplinkChain.push({
				propPath: uplinkPropPath,
				value: uplinkValueFunc
			});
			recordTypeDesc = uplinkRecordTypeDesc;
		}
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
		let uriParamInd = uriParams.length + lastUplinkParamInd;
		for (let uplink of this._uplinkChain) {
			const paramName = 'uri' + uriParamInd;
			queryParams[paramName] = uplink.value(uriParams[uriParamInd]);
			filters.push([ uplink.propPath, dbos.param(paramName) ]);
			uriParamInd--;
		}
	}

	/**
	 * Transaction phases.
	 *
	 * @interface TransactionPhases
	 * @memberof module:x2node-ws-resources~AbstractResourceHandler
	 * @protected
	 */
	/**
	 * Optional hook called before transaction is started. If returns thruthy
	 * result, the transaction is never executed and the result is returned.
	 *
	 * @function module:x2node-ws-resources~AbstractResourceHandler.TransactionPhases#beforeTransaction
	 * @returns {*} Result to return as the handler response, or a falsy value to
	 * proceed with the transaction.
	 */
	/**
	 * Optional hook called after the transaction is started, but before the main
	 * action is executed.
	 *
	 * @function module:x2node-ws-resources~AbstractResourceHandler.TransactionPhases#beforeAction
	 * @param {module:x2node-dbos~Transaction} tx The active transaction.
	 * @returns {Promise} If the returned promise resolves to a thruthy value,
	 * the action is never executed, transaction is committed and the value is
	 * returned as the handler response. If the promise resolved to a falsy
	 * value, the main action is executed next. If the promise is rejected, the
	 * transaction is rolled back and the handler is made to reject the call with
	 * the hook's rejection reason.
	 */
	/**
	 * The main transaction action.
	 *
	 * @function module:x2node-ws-resources~AbstractResourceHandler.TransactionPhases#action
	 * @param {module:x2node-dbos~Transaction} tx The active transaction.
	 * @returns {Promise} Promise of the handler response. If rejected, the
	 * transaction is automatically rolled back.
	 */
	/**
	 * Optional hook called after the main action has been successfully executed
	 * but before the transaction is committed.
	 *
	 * @function module:x2node-ws-resources~AbstractResourceHandler.TransactionPhases#afterAction
	 * @param {module:x2node-dbos~Transaction} tx The active transaction.
	 * @param {*} mainActionResult Resolved main action result.
	 * @returns {Promise} Promise of the handler response. If rejected, the
	 * transaction is automatically rolled back.
	 */

	/**
	 * Execute handler action in a transaction.
	 *
	 * @protected
	 * @param {module:x2node-ws-resources~AbstractResourceHandler.TransactionPhases} phases
	 * Transaction phases.
	 * @returns {*} Handler response from one of the phases, or a promise of it.
	 */
	_executeTransaction(phases) {

		// execute before transaction hook, if any
		if (phases.beforeTransaction) {
			try {
				const res = phases.beforeTransaction();
				if (res)
					return res;
			} catch (err) {
				return Promise.reject(err);
			}
		}

		// get connection, organize transaction and execute the phases
		return this._ds.getConnection().then(
			con => {
				const tx = this._dboFactory.newTransaction(con);
				return tx.start().then(

					// execute transaction phases
					() => {

						// phases promise chain
						let promiseChain = Promise.resolve();

						// queue up before action hook, if any
						if (phases.beforeAction)
							promiseChain = promiseChain.then(
								() => {
									try {
										return phases.beforeAction(tx);
									} catch (err) {
										return Promise.reject(err);
									}
								},
								err => Promise.reject(err)
							);

						// queue up main action
						let skipAction = false;
						promiseChain = promiseChain.then(
							beforeActionResult => {
								if (beforeActionResult) {
									skipAction = true;
									return beforeActionResult;
								}
								try {
									return phases.action(tx);
								} catch (err) {
									return Promise.reject(err);
								}
							},
							err => Promise.reject(err)
						);

						// queue up after action hook, if any
						if (phases.afterAction)
							promiseChain = promiseChain.then(
								result => {
									if (skipAction)
										return result;
									try {
										return phases.afterAction(tx, result);
									} catch (err) {
										return Promise.reject(err);
									}
								},
								err => Promise.reject(err)
							);

						// return the chain
						return promiseChain;
					},

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
						this._ds.releaseConnection(con);
						return result;
					},
					err => {
						this._ds.releaseConnection(con, err);
						return Promise.reject(err);
					}
				);
			},

			err => Promise.reject(err)
		);
	}
}

// export the class
module.exports = AbstractResourceHandler;
