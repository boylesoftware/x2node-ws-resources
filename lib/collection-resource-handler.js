'use strict';

const common = require('x2node-common');
const ws = require('x2node-ws');
const dbos = require('x2node-dbos');
const validators = require('x2node-validators');

const AbstractResourceHandler = require('./abstract-resource-handler.js');


// TODO: cache DBOs

/**
 * Order end operations mapping for the "o" query parameter.
 *
 * @private
 * @constant {Object.<string,string>}
 */
const ORDER_OPS_MAPPING = {
	'': 'asc',
	'asc': 'asc',
	'desc': 'desc'
};

/**
 * Filter end operations mapping for the "f$" query parameters.
 *
 * @private
 * @constant {Object.<string,string>}
 */
const FILTER_OPS_MAPPING = {
	'': '!empty',
	'$value': 'eq',
	'!': 'empty',
	'$value!': 'ne',
	'min': 'ge',
	'max': 'le',
	'pat': 'matchesi',
	'sub': 'containsi',
	'pre': 'startsi',
	'alt': 'in',
	'min!': 'lt',
	'max!': 'gt',
	'pat!': '!matchesi',
	'sub!': '!containsi',
	'pre!': '!startsi',
	'alt!': '!in'
};

/**
 * Regular expression for filter query parameter names.
 *
 * @private
 * @constant {RegExp}
 */
const FILTER_PARAM_RE = /^f([^$]*)\$(.*)$/;

/**
 * Standard collection resource web wervice endpoint handler.
 *
 * @memberof module:x2node-ws-resources
 * @inner
 * @extends module:x2node-ws~AbstractResourceHandler
 * @implements module:x2node-ws.Handler
 */
class CollectionResourceHandler extends AbstractResourceHandler {

	/**
	 * <strong>Note:</strong> The constructor is not accessible from the client
	 * code. Instances are created using module's
	 * [createCollectionResourceHandler()]{@link module:x2node-ws-resources.createCollectionResourceHandler}
	 * function.
	 *
	 * @protected
	 * @param {module:x2node-dbos.DataSource} ds Data source.
	 * @param {module:x2node-dbos~DBOFactory} dboFactory DBO factory.
	 * @param {string} rsrcPath Resource path.
	 * @param {Object} [options] Options.
	 */
	constructor(ds, dboFactory, rsrcPath, options) {
		super(ds, dboFactory, rsrcPath);

		this._options = options;
	}

	// call permissions checker
	isAllowed(call) {

		// TODO: implement ACLs
		return true;
	}

	// process GET call
	GET(call) {

		// build the DBO
		const queryParams = new Object();
		let dbo, querySpec;
		try {

			// parse query string
			const querySpec = this._parseQuery(
				call.requestUrl.query, queryParams);

			// add uplink filters
			this._addUplinkFilters(call, -1, querySpec.filter, queryParams);

			// build the DBO
			dbo = this._dboFactory.buildFetch(this._recordTypeName, querySpec);

		} catch (err) {
			if (err instanceof common.X2SyntaxError) {
				this._log('invalid query string: ' + err.message);
				return ws.createResponse(400).setEntity({
					errorCode: 'X2-RSRC-400-1',
					errorMessage: 'Invalid query string.'
				});
			}
			throw err;
		}

		// execute the DBO
		return this._executeTransaction({
			action: tx => dbo.execute(tx, call.actor, queryParams)
		});
	}

	/**
	 * Parse URL query parameters into a query specification for the fetch DBO.
	 *
	 * @private
	 * @param {Object} urlQuery URL query parameters.
	 * @param {Object.<string,*>} queryParams Fetch query parameters to populate.
	 * @returns {Object} Fetch DBO query specification, or <code>null</code> if
	 * invalid URL query parameters.
	 * @throws {common.X2SyntaxError} If query parameters are invalid.
	 */
	_parseQuery(urlQuery, queryParams) {

		// query spec object to build
		const querySpec = new Object();

		// parse properties spec
		if (urlQuery.p)
			querySpec.props = urlQuery.p.split(',');

		// parse filter spec
		//querySpec.filter = this._parseFilterParams(urlQuery);
		console.log('>>> FILTER: ' + JSON.stringify(this._parseFilterParams(urlQuery), null, '  '));

		// parse order spec
		if (urlQuery.o) {
			querySpec.order = new Array();
			for (let oElement of urlQuery.o.split(',')) {
				querySpec.order.push(this._parseQueryPropRef(
					this._recordTypeDesc, oElement, ORDER_OPS_MAPPING).spec);
			}
		}

		// parse range spec
		if (urlQuery.r)
			querySpec.range = urlQuery.r.split(',').map(v => Number(v));

		// return parsed query spec
		return querySpec;
	}

	_parseFilterParams(urlQuery) {

		// get all filter groups
		const groups = new Map();
		for (let paramName of Object.keys(urlQuery)) {
			const m = FILTER_PARAM_RE.exec(paramName);
			if (!m)
				continue;
			const groupId = m[1];
			let group = groups.get(groupId);
			if (!group)
				groups.set(groupId, group = {
					id: groupId,
					junc: ':and',
					members: new Array()
				});
			const refExpr = m[2];
			if (refExpr.startsWith(':')) {
				switch (refExpr) {
				case ':or':
					group.junc = ':or';
					break;
				case ':or!':
					group.junc = ':!or';
					break;
				case ':and':
					group.junc = ':and';
					break;
				case ':and!':
					group.junc = ':!and';
					break;
				default:
					throw new common.X2SyntaxError(
						`Invalid filter group "${paramName}" junction type` +
							` "${valExpr}".`);
				}
			} else {
				group.members.push({
					refExpr: refExpr,
					valExpr: urlQuery[paramName]
				});
			}
		}

		// sort groups
		const groupIds = Array.from(groups.keys()).sort();
		console.log('>>> group ids:', groupIds);

		// assemble the filter specification
		const filter = new Array();
		const groupStack = new Array();
		groupStack.push({
			id: '',
			filterElements: filter
		});
		for (let groupId of groupIds) {
			const group = groups.get(groupId);

			group.filterElements = new Array();
			group.filter = [ group.junc, group.filterElements ];
			for (let member of group.members) {
				//...
				group.filterElements.push(member.refExpr); // just a test
			}

			let parentGroup;
			while (!groupId.startsWith(
				(parentGroup = groupStack[groupStack.length - 1]).id))
				groupStack.pop();
			parentGroup.filterElements.push(group.filter);

			groupStack.push(group);
		}

		/*const pred = this._parseQueryPropRef(
			this._recordTypeDesc, refExpr, FILTER_OPS_MAPPING,
			(valueExpr.length > 0));*/

		// return the result
		return (filter.length > 0 ? filter : undefined);
	}

	/**
	 * Parse property value expression from the query string.
	 *
	 * @private
	 * @param {module:x2node-records~PropertiesContainer} baseContainer Base
	 * properties container for property paths.
	 * @param {string} propRef Property value expression.
	 * @param {Object.<string,string>} opsMapping Mapping for end operations.
	 * @param {boolean} [hasValue] Optional flag telling if there is a value
	 * associated with the expression.
	 * @returns {Object} Result descriptor with the value specification and
	 * value type.
	 * @throws {common.X2SyntaxError} If the value expression is invalid.
	 */
	_parseQueryPropRef(baseContainer, propRef, opsMapping, hasValue) {

		const invert = propRef.endsWith('!');
		if (invert)
			propRef = propRef.substring(0, propRef.length - 1);

		const propRefParts = propRef.split(':');

		let spec, valueType, opRef = (hasValue ? '$value': '');
		for (let i = 0, len = propRefParts.length; i < len; i++) {
			const propRefPart = propRefParts[i];

			if (i === 0) {

				spec = propRefPart;

				let container = baseContainer;
				for (let propName of propRefPart.split('.')) {
					if (!container || !container.hasProperty(propName))
						throw new common.X2SyntaxError(
							`Invalid property path ${propRefPart}.`);
					const propDesc = container.getPropertyDesc(propName);
					valueType = propDesc.scalarValueType;
					container = propDesc.nestedProperties;
				}

			} else {

				let arg1, arg2;
				switch (propRefPart) {

				case 'len':
					if (valueType !== 'string')
						throw new common.X2SyntaxError(
							'Value transformation "len" expects string input.');
					spec = `length(${spec})`;
					valueType = 'number';
					break;

				case 'lc':
					if (valueType !== 'string')
						throw new common.X2SyntaxError(
							'Value transformation "lc" expects string input.');
					spec = `lower(${spec})`;
					valueType = 'string';
					break;

				case 'sub':
					if (valueType !== 'string')
						throw new common.X2SyntaxError(
							'Value transformation "sub" expects string input.');
					if (i + 2 >= len)
						throw new common.X2SyntaxError(
							'Value transformation "sub" expects two arguments.');
					arg1 = Number(propRefParts[++i]);
					if (!Number.isInteger(arg1) || (arg1 < 0))
						throw new common.X2SyntaxError(
							'Value transformation "sub" expects positive' +
								' integer first argument.');
					arg2 = propRefParts[++i];
					if (arg2.length > 0) {
						arg2 = Number(arg2);
						if (!Number.isInteger(arg2) || (arg2 < 0))
							throw new common.X2SyntaxError(
								'Value transformation "sub" expects empty or' +
									' positive integer second argument.');
						spec = `substring(${spec}, ${arg1}, ${arg2})`;
					} else {
						spec = `substring(${spec}, ${arg1})`;
					}
					valueType = 'string';
					break;

				case 'lpad':
					if (valueType !== 'string')
						throw new common.X2SyntaxError(
							'Value transformation "lpad" expects string input.');
					if (i + 2 >= len)
						throw new common.X2SyntaxError(
							'Value transformation "lpad" expects two' +
								' arguments.');
					arg1 = Number(propRefParts[++i]);
					if (!Number.isInteger(arg1) || (arg1 < 0))
						throw new common.X2SyntaxError(
							'Value transformation "lpad" expects positive' +
								' integer first argument.');
					arg2 = propRefParts[++i];
					if (arg2.length === 0)
						arg2 = ' ';
					else if (arg2.length > 1)
						throw new common.X2SyntaxError(
							'Value transformation "lpad" expects empty or' +
								' single character second argument.');
					spec = `lpad(${spec}, ${arg1}, "${arg2}")`;
					valueType = 'string';
					break;

				default:
					if (i < len - 1)
						throw new common.X2SyntaxError(
							'Unknown transformation "' + propRefPart + '".');
					opRef = propRefPart;
				}
			}
		}

		if (invert)
			opRef += '!';
		const op = opsMapping[opRef];
		if (!op)
			throw new common.X2SyntaxError(
				'Unknown operation "' + opRef + '".');

		return {
			spec: `${spec} => ${op}`,
			valueType: valueType
		};
	}

	// process POST call
	POST(call) {

		// make sure that we have the entity
		const record = call.entity;
		if (!record)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-2',
				errorMessage: 'Expected record data in the request entity.'
			});

		// validate the record data
		const errors = validators.normalizeRecord(
			this._dboFactory.recordTypes, this._recordTypeName, record,
			call.httpRequest.headers['Accept-Language'], 'onCreate');
		if (errors)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-3',
				errorMessage: 'Invalid record data.',
				validationErrors: errors
			});

		// build the DBOs
		const insertDBO = this._dboFactory.buildInsert(
			this._recordTypeName, record);
		const idPropName = this._recordTypeDesc.idPropertyName;
		const fetchDBO = this._dboFactory.buildFetch(this._recordTypeName, {
			filter: [ [ idPropName, dbos.param('id') ] ]
		});

		// TODO: validate uplink references

		// execute the DBOs and return the result
		return this._executeTransaction({
			action: tx => insertDBO.execute(tx, call.actor),
			afterAction: (tx, recordId) => fetchDBO.execute(tx, call.actor, {
				id: recordId
			})
		}).then(
			result => ws.createResponse(201)
				.setHeader(
					'Location', call.requestUrl.pathname + '/' +
						encodeURIComponent(result.records[0][idPropName]))
				.setEntity(result.records[0]),
			err => Promise.reject(err)
		);
	}
}

// export the class
module.exports = CollectionResourceHandler;
