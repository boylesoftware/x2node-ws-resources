'use strict';

const CollectionResourceHandler = require('./collection-resource-handler.js');
const IndividualResourceHandler = require('./individual-resource-handler.js');


/**
 * Resource handlers factory.
 *
 * @memberof module:x2node-ws-resources
 * @inner
 */
class ResourceHandlersFactory {

	/**
	 * <strong>Note:</strong> The constructor is not accessible from the client
	 * code. Instances are created using module's
	 * [createResourceHandlersFactory()]{@link module:x2node-ws-resources.createResourceHandlersFactory}
	 * function.
	 *
	 * @protected
	 * @param {module:x2node-dbos.DataSource} ds Data source.
	 * @param {module:x2node-dbos~DBOFactory} dboFactory DBO factory.
	 * @param {Object} [defaultOptions] Default options for handlers.
	 */
	constructor(ds, dboFactory, defaultOptions) {

		this._ds = ds;
		this._dboFactory = dboFactory;
		this._defaultOptions = defaultOptions;
	}

	/**
	 * Create collection resource handler.
	 *
	 * @param {string} rsrcPath Resource path.
	 * @param {Object} [handlerExt] Handler extension.
	 * @returns {module:x2node-ws-resources.CollectionResourceHandler} The
	 * handler.
	 */
	collectionResource(rsrcPath, handlerExt) {

		return this._createResourceHandler(
			CollectionResourceHandler, rsrcPath, handlerExt);
	}

	/**
	 * Create individual resource handler.
	 *
	 * @param {string} rsrcPath Resource path.
	 * @param {Object} [handlerExt] Handler extension.
	 * @returns {module:x2node-ws-resources.IndividualResourceHandler} The
	 * handler.
	 */
	individualResource(rsrcPath, handlerExt) {

		return this._createResourceHandler(
			IndividualResourceHandler, rsrcPath, handlerExt);
	}

	/**
	 * Create handler.
	 *
	 * @private
	 * @param {function} BaseHandler Base handler constructor.
	 * @param {string} rsrcPath Resource path.
	 * @param {Object} [handlerExt] Handler extension.
	 * @returns {module:x2node-ws.Handler} The handler.
	 */
	_createResourceHandler(BaseHandler, rsrcPath, handlerExt) {

		// create base handler
		const handler = new BaseHandler(
			this._ds, this._dboFactory, rsrcPath, this._defaultOptions);

		// extend it
		if (handlerExt) {
			for (let m of Object.getOwnPropertyNames(handlerExt))
				handler[m] = handlerExt[m];
		}

		// configure it
		if ((typeof handler.configure) === 'function')
			handler.configure();

		// return it
		return handler;
	}
}

// export the class
module.exports = ResourceHandlersFactory;
