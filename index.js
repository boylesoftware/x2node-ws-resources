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
const searchQueryParser = require('./lib/search-query-parser.js');


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

// export search query parser
exports.parseSearchQuery = searchQueryParser.parseSearchQuery;

/**
 * Validators to use on auto-assigned required properties in the record types
 * library definition. When a new record is created, requires the property to be
 * empty. When the record is being updated, requires the property to have value.
 */
exports.AUTOASSIGNED = {
	'onCreate': [ 'empty' ],
	'onUpdate': [ 'required' ],
	'*': [ '-required' ]
};

/**
 * Validators to use on optionally auto-assigned required properties in the
 * record types library definition. When a new record is created, the property is
 * allowed to be empty or not. When the record is being updated, requires the
 * property to have value.
 */
exports.OPTIONALLY_AUTOASSIGNED = {
	'onUpdate': [ 'required' ],
	'*': [ '-required' ]
};
