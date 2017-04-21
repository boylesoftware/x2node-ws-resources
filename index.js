/**
 * Persistent resources for the web services module.
 *
 * @module x2node-ws-resources
 * @requires module:x2node-common
 * @requires module:x2node-dbos
 * @requires module:x2node-ws
 */
'use strict';

const ResourceHandlersFactory = require('./lib/resource-handlers-factory.js');


// export the base handler classes
exports.CollectionResourceHandler = require(
	'./lib/collection-resource-handler.js');
exports.IndividualResourceHandler = require(
	'./lib/individual-resource-handler.js');

/**
 * Create resource handlers factory.
 *
 * @param {module:x2node-dbos.DataSource} ds Data source.
 * @param {module:x2node-dbos~DBOFactory} dboFactory DBO factory.
 * @param {Object} [defaultOptions] Default options for handlers.
 */
exports.createResourceHandlersFactory = function(
	ds, dboFactory, defaultOptions) {

	return new ResourceHandlersFactory(ds, dboFactory, defaultOptions);
};
