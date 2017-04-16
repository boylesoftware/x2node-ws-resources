'use strict';

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
}

// export the class
module.exports = IndividualResourceHandler;
