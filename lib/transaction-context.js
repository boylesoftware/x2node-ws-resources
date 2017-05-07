'use strict';

const patches = require('x2node-patches');


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
	get transaction() { return this.tx; }

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

		// result promise
		let resultPromise;

		// array of records?
		if (Array.isArray(records)) {

			resultPromise = Promise.resolve(new Array());
			for (let record of records)
				resultPromise = resultPromise.then(
					recordIds => this._dboFactory.buildInsert(
						recordTypeName, record).execute(
							this._tx, this._call.actor).then(
								recordId => {
									recordIds.push(recordId);
									return recordIds;
								},
								err => Promise.reject(err)
							),
					err => Promise.reject(err)
				);

		} else { // single record

			resultPromise = this._dboFactory.buildInsert(recordTypeName, records)
				.execute(this._tx, this._call.actor);
		}

		// add pass through if any
		if (passThrough !== undefined)
			resultPromise = resultPromise.then(
				() => passThrough,
				err => Promise.reject(err)
			);

		// return the result promise
		return resultPromise;
	}

	/**
	 * Convenience shortcut for building and executing an update DBO.
	 *
	 * @see [buildUpdate()]{@link module:x2node-dbos~DBOFactory#buildUpdate}
	 *
	 * @param {string} recordTypeName Name of the record type to update.
	 * @param {Array.<Object>} patch Update specification in JSON Patch format.
	 * @param {Array.<Array>} filterSpec Selector for records to update.
	 * @param {*} [passThrough] If provided, the returned promise resolves with
	 * this value instead of the update DBO result (which is lost in that case).
	 * @returns {(Promise.<module:x2node-dbos~UpdateDBO~Result>|*)} Promise of
	 * either the update result object or the pass through object.
	 */
	update(recordTypeName, patchSpec, filterSpec, passThrough) {

		// do the update
		let resultPromise = this._dboFactory.buildUpdate(
			recordTypeName, patches.build(
				this._recordTypes, recordTypeName, patchSpec), filterSpec)
			.execute(this._tx, this._call.actor);

		// add pass through if any
		if (passThrough !== undefined)
			resultPromise = resultPromise.then(
				() => passThrough,
				err => Promise.reject(err)
			);

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

		return this._dboFactory.buildDelete(recordTypeName, filterSpec)
			.execute(this._tx, this._call.actor);
	}
}

// export the class
module.exports = TransactionContext;