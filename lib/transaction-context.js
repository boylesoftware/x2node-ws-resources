'use strict';

const common = require('x2node-common');
const patches = require('x2node-patches');
const ws = require('x2node-ws');


/**
 * Resource handler transaction context.
 *
 * @memberof module:x2node-ws-resources
 * @inner
 */
class TransactionContext {

	/**
	 * <strong>Note:</strong> The constructor is not accessible from the client
	 * code. Instances are created internally in the framework and are provided
	 * to handler extensions.
	 *
	 * @protected
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @param {module:x2node-dbos~DBOFactory} dboFactory The DBO factory.
	 */
	constructor(call, dboFactory) {

		this._call = call;
		this._dboFactory = dboFactory;
		this._recordTypes = dboFactory.recordTypes;

		this._listeners = {};

		this._complete = false;

		/**
		 * The transaction.
		 *
		 * @protected
		 * @member {module:x2node-dbos~Transaction}
		 */
		this._tx = undefined;
	}

	/**
	 * The transaction, if active.
	 *
	 * @member {module:x2node-dbos~Transaction=}
	 * @readonly
	 */
	get transaction() { return this._tx; }

	/**
	 * The web service endpoint call.
	 *
	 * @member {module:x2node-ws~ServiceCall}
	 * @readonly
	 */
	get call() { return this._call; }

	/**
	 * DBO factory.
	 *
	 * @member {module:x2node-dbos~DBOFactory}
	 * @readonly
	 */
	get dboFactory() { return this._dboFactory; }

	/**
	 * Record types library.
	 *
	 * @member {module:x2node-records~RecordTypesLibrary}
	 * @readonly
	 */
	get recordTypes() { return this._recordTypes; }

	/**
	 * Mark the transaction as complete. The rest of the transaction phases are
	 * skipped, the transaction is committed and the handler returns the result
	 * of the current transaction phase.
	 */
	makeComplete() { this._complete = true; }

	/**
	 * Tells if the transaction has been marked as complete.
	 *
	 * @protected
	 * @member {boolean}
	 * @readonly
	 */
	get complete() { return this._complete; }

	/**
	 * Convert record reference to record id. Shortcut for
	 * <code>recordTypes.refToId(recordTypeName, ref)</code>.
	 *
	 * @param {string} recordTypeName Reference target record type name.
	 * @param {string} ref Record reference.
	 * @returns {(string|number)} Record id.
	 * @throws {module:x2node-common.X2SyntaxError} If reference is invalid.
	 */
	refToId(recordTypeName, ref) {

		return this._recordTypes.refToId(recordTypeName, ref);
	}

	/**
	 * Add listener for the specified transaction event.
	 *
	 * @param {string} eventName Event name. Can be 'commit' or 'rollback'.
	 * The 'commit' event listeners are call right after successful transaction
	 * commit. The 'rollback' event listeners are called right after transaction
	 * rollback (either successful or failed).
	 * @param {function} listener The listener function. The listener return
	 * values are ignored. If any listener throws an error, the error is logged
	 * but otherwise the process is not affected.
	 * @returns {module:x2node-ws-resources~TransactionContext} This context for
	 * chaining.
	 */
	on(eventName, listener) {

		let listeners = this._listeners[eventName];
		if (!listeners)
			listeners = this._listeners[eventName] = new Array();

		if ((typeof listener) !== 'function')
			throw new common.X2UsageError('Listener is not a function.');

		listeners.push(listener);

		return this;
	}

	/**
	 * Call the event listeners.
	 *
	 * @protected
	 * @param {string} eventName The event name.
	 */
	emit(eventName) {

		const listeners = this._listeners[eventName];
		if (listeners)
			for (let listener of listeners) {
				try {
					listener();
				} catch (err) {
					common.error(
						`Error in the ${eventName} event listener:`, err);
				}
			}
	}

	/**
	 * Convenience shortcut for building and executing a fetch DBO.
	 *
	 * @see [buildFetch()]{@link module:x2node-dbos~DBOFactory#buildFetch}
	 *
	 * @param {string} recordTypeName Name of the record type to fetch.
	 * @param {Object} querySpec Query specification.
	 * @returns {Promise.<module:x2node-dbos~FetchDBO~Result>} The fetch result
	 * promise.
	 */
	fetch(recordTypeName, querySpec) {

		if (!this._tx)
			throw new common.X2UsageError('Outside of transaction.');

		return this._dboFactory.buildFetch(recordTypeName, querySpec)
			.execute(this._tx, this._call.actor);
	}

	/**
	 * Convenience shortcut for building and executing an insert DBO.
	 *
	 * @see [buildInsert()]{@link module:x2node-dbos~DBOFactory#buildInsert}
	 *
	 * @param {string} recordTypeName Name of the record type to insert.
	 * @param {(Object|Array.<Object>)} records Record template or an array of
	 * record templates.
	 * @param {*} [passThrough] If provided, the returned promise resolves with
	 * this value instead of the inserted record ids (which are lost in that
	 * case).
	 * @returns {Promise.<(string|number|Array.<(string|number)>|*)>} Promise of
	 * the new record id(s) or the pass through object.
	 */
	insert(recordTypeName, records, passThrough) {

		if (!this._tx)
			throw new common.X2UsageError('Outside of transaction.');

		// result promise
		let resultPromise;

		// array of records?
		if (Array.isArray(records)) {

			resultPromise = Promise.resolve(new Array());
			for (let record of records)
				resultPromise = resultPromise.then(
					recordIds => this._dboFactory.buildInsert(
						recordTypeName, record
					).execute(
						this._tx, this._call.actor
					).then(recordId => {
							recordIds.push(recordId);
							return recordIds;
					})
				);

		} else { // single record

			resultPromise = this._dboFactory.buildInsert(
				recordTypeName, records
			).execute(this._tx, this._call.actor);
		}

		// add pass through if any
		if (passThrough !== undefined)
			resultPromise = resultPromise.then(() => passThrough);

		// return the result promise
		return resultPromise;
	}

	/**
	 * Convenience shortcut for building and executing an update DBO.
	 *
	 * <p>Note, no post-update validation is performed.
	 *
	 * @see [buildUpdate()]{@link module:x2node-dbos~DBOFactory#buildUpdate}
	 *
	 * @param {string} recordTypeName Name of the record type to update.
	 * @param {Array.<Object>} patchSpec Update specification in JSON Patch
	 * format.
	 * @param {Array.<Array>} filterSpec Selector for records to update.
	 * @param {*} [passThrough] If provided, the returned promise resolves with
	 * this value instead of the update DBO result (which is lost in that case).
	 * @returns {(Promise.<module:x2node-dbos~UpdateDBO~Result>|*)} Promise of
	 * either the update result object or the pass through object.
	 */
	update(recordTypeName, patchSpec, filterSpec, passThrough) {

		if (!this._tx)
			throw new common.X2UsageError('Outside of transaction.');

		// do the update
		let resultPromise = this._dboFactory.buildUpdate(
			recordTypeName, patches.build(
				this._recordTypes, recordTypeName, patchSpec), filterSpec)
			.execute(this._tx, this._call.actor);

		// add pass through if any
		if (passThrough !== undefined)
			resultPromise = resultPromise.then(() => passThrough);

		// return the result promise
		return resultPromise;
	}

	/**
	 * Convenience shortcut for building and executing a fetch DBO followed by a
	 * sequence of update DBOs for each fetched record. The main difference from
	 * the [update()]{@link module:x2node-dbos~TransactionContext#update} method
	 * is that this method allows building patch specification individually for
	 * each matched record based on the matched record data.
	 *
	 * <p>Note, no post-update validation is performed.
	 *
	 * @see [buildFetch()]{@link module:x2node-dbos~DBOFactory#buildFetch}
	 * @see [buildUpdate()]{@link module:x2node-dbos~DBOFactory#buildUpdate}
	 *
	 * @param {string} recordTypeName Name of the record type to update.
	 * @param {function} patchSpecProvider Function that takes a record as its
	 * only argument and returns the patch specification in JSON Patch format.
	 * @param {Array.<Array>} filterSpec Selector for records to update.
	 * @param {Array.<string>} [orderSpec] Order specification. The records are
	 * updated in the specified order.
	 * @param {*} [passThrough] If provided, the returned promise resolves with
	 * this value instead of the update DBO result (which is lost in that case).
	 * @returns {(Promise.<module:x2node-dbos~UpdateDBO~Result>|*)} Promise of
	 * either the update result object or the pass through object.
	 */
	dynamicUpdate(
		recordTypeName, patchSpecProvider, filterSpec, orderSpec, passThrough) {

		if (!this._tx)
			throw new common.X2UsageError('Outside of transaction.');

		// fetch the records
		let resultPromise = this._dboFactory.buildFetch(recordTypeName, {
			props: [ '*' ],
			filter: filterSpec,
			order: orderSpec,
			lock: 'exclusive'
		}).execute(this._tx, this._call.actor);

		// update fetched records
		resultPromise = resultPromise.then(fetchResult => {

			// perform updates for each fetched record
			return fetchResult.records.reduce((chain, record) => chain.then(
				updateResult => this._dboFactory.buildUpdate(
					recordTypeName,
					patches.build(
						this._recordTypes, recordTypeName,
						patchSpecProvider(record)
					),
					() => [ record ]
				).execute(this._tx, this._call.actor).then(r => ({
					records: updateResult.records,
					updatedRecordIds: updateResult.updatedRecordIds.concat(
						r.updatedRecordIds),
					testFailed: (updateResult.testFailed || r.testFailed),
					failedRecordIds: (
						updateResult.failedRecordIds ?
							(
								r.failedRecordIds ?
									updateResult.failedRecordIds.concat(
										r.failedRecordIds)
									: updateResult.failedRecordIds
							) : r.failedRecordIds
					)
				}))
			), Promise.resolve({
				records: fetchResult.records,
				updatedRecordIds: [],
				testFailed: false,
				failedRecordIds: undefined
			}));
		});

		// add pass through if any
		if (passThrough !== undefined)
			resultPromise = resultPromise.then(() => passThrough);

		// return the result promise
		return resultPromise;
	}

	/**
	 * Convenience shortcut for building and executing a delete DBO.
	 *
	 * @see [buildDelete()]{@link module:x2node-dbos~DBOFactory#buildDelete}
	 *
	 * @param {string} recordTypeName Name of the record type to delete.
	 * @param {Array.<Array>} filterSpec Selector for records to delete.
	 * @returns {Promise.<module:x2node-dbos~DeleteDBO~Result>} The operation
	 * result object promise.
	 */
	delete(recordTypeName, filterSpec) {

		if (!this._tx)
			throw new common.X2UsageError('Outside of transaction.');

		return this._dboFactory.buildDelete(recordTypeName, filterSpec)
			.execute(this._tx, this._call.actor);
	}

	/**
	 * Convenience shortcut for checking if records of a given record type
	 * matching the specified filter exist and if so, return a promise rejected
	 * with an error HTTP response. The method also locks the whole records
	 * collection in shared mode (to prevent creation of the matching records by
	 * a concurrent transaction until this transaction is complete).
	 *
	 * @param {string} recordTypeName Name of the record type to check.
	 * @param {Array.<Array>} filterSpec Records filter.
	 * @param {number} httpStatusCode HTTP response status code for the error
	 * response.
	 * @param {string} errorMessage Message for the error response.
	 * @returns {Promise.<module:x2node-ws~ServiceResponse>} Promise that gets
	 * rejected with a service response if matching records exist. If matching
	 * records do not exist, the promise is fulfulled with nothing.
	 */
	rejectIfExists(recordTypeName, filterSpec, httpStatusCode, errorMessage) {

		if (!this._tx)
			throw new common.X2UsageError('Outside of transaction.');

		return this._dboFactory.recordCollectionsMonitor.lockCollections(
			this._tx, [ recordTypeName ], 'shared'
		).then(() => this.fetch(recordTypeName, {
			props: [ '.count' ],
			filter: filterSpec
		})).then(result => {
			if (result.count > 0)
				return Promise.reject(
					ws.createResponse(httpStatusCode).setEntity({
						errorMessage: errorMessage
					}));
		});
	}

	/**
	 * Convenience shortcut for checking if records of a given record type
	 * matching the specified filter do not exist and if so, return a promise
	 * rejected with an error HTTP response. If records do exist, they are also
	 * locked by the method in shared mode for the transaction.
	 *
	 * @param {string} recordTypeName Name of the record type to check.
	 * @param {Array.<Array>} filterSpec Records filter.
	 * @param {number} httpStatusCode HTTP response status code for the error
	 * response.
	 * @param {string} errorMessage Message for the error response.
	 * @returns {Promise.<module:x2node-ws~ServiceResponse>} Promise that gets
	 * rejected with a service response if no matching records exist. If matching
	 * records do exist, the promise is fulfulled with nothing.
	 */
	rejectIfNotExists(recordTypeName, filterSpec, httpStatusCode, errorMessage) {

		return this.fetch(recordTypeName, {
			props: [],
			filter: filterSpec,
			lock: 'shared'
		}).then(
			result => {
				if (result.records.length === 0)
					return Promise.reject(
						ws.createResponse(httpStatusCode).setEntity({
							errorMessage: errorMessage
						}));
			},
			err => Promise.reject(err)
		);
	}

	/**
	 * Convenience shortcut for checking if exact number of records of a given
	 * record type matching the specified filter exists and if not, return a
	 * promise rejected with an error HTTP response. The existing records are
	 * also locked by the method in shared mode for the transaction.
	 *
	 * @param {string} recordTypeName Name of the record type to check.
	 * @param {Array.<Array>} filterSpec Records filter.
	 * @param {number} expectedNum Expected number of existing records.
	 * @param {number} httpStatusCode HTTP response status code for the error
	 * response.
	 * @param {string} errorMessage Message for the error response.
	 * @returns {Promise.<module:x2node-ws~ServiceResponse>} Promise that gets
	 * rejected with a service response if number of existing matching records
	 * does not match. If it matches, the promise is fulfulled with nothing.
	 */
	rejectIfNotExactNum(
		recordTypeName, filterSpec, expectedNum, httpStatusCode, errorMessage) {

		return this.fetch(recordTypeName, {
			props: [],
			filter: filterSpec,
			lock: 'shared'
		}).then(
			result => {
				if (result.records.length !== expectedNum)
					return Promise.reject(
						ws.createResponse(httpStatusCode).setEntity({
							errorMessage: errorMessage
						}));
			},
			err => Promise.reject(err)
		);
	}
}

// export the class
module.exports = TransactionContext;
