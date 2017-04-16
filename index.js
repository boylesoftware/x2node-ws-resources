/**
 * Persistent resources for the web services module.
 *
 * @module x2node-ws-resources
 * @requires module:x2node-common
 * @requires module:x2node-dbos
 * @requires module:x2node-ws
 */
'use strict';

const CollectionResourceHandler = require(
	'./lib/collection-resource-handler.js');
const IndividualResourceHandler = require(
	'./lib/individual-resource-handler.js');


/**
 * Create collection resource endpoint handler.
 *
 * @param {module:x2node-dbos.DataSource} ds Data source.
 * @param {module:x2node-dbos~DBOFactory} dboFactory DBO factory.
 * @param {string} rsrcPath Resource path.
 * @param {Object} [options] Options.
 */
exports.createCollectionResourceHandler = function(
	ds, dboFactory, rsrcPath, options) {

	return new CollectionResourceHandler(ds, dboFactory, rsrcPath, options);
};

/**
 * Create individual resource endpoint handler.
 *
 * @param {module:x2node-dbos.DataSource} ds Data source.
 * @param {module:x2node-dbos~DBOFactory} dboFactory DBO factory.
 * @param {string} rsrcPath Resource path.
 * @param {Object} [options] Options.
 */
exports.createIndividualResourceHandler = function(
	ds, dboFactory, rsrcPath, options) {

	return new IndividualResourceHandler(ds, dboFactory, rsrcPath, options);
};
