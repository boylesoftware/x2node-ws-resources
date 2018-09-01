'use strict';

const common = require('x2node-common');
const dbos = require('x2node-dbos');


/**
 * Order end operations mapping for the "o" query parameter.
 *
 * @private
 * @constant {Object.<string,string>}
 */
const ORDER_OPS_MAPPING = {
	'$default': 'asc',
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
	'$default': '!empty',
	'$default:collection': '!empty',
	'$default:value': 'eq',
	'$default:collection:value': '!empty',
	'$default!': 'empty',
	'$default:collection!': 'empty',
	'$default:value!': 'ne',
	'$default:collection:value!': 'empty',
	'min': 'ge',
	'max': 'le',
	'pat': 'matchesi',
	'mid': 'containsi',
	'pre': 'startsi',
	'alt': 'in',
	'count': 'count',
	'min!': 'lt',
	'max!': 'gt',
	'pat!': '!matchesi',
	'mid!': '!containsi',
	'pre!': '!startsi',
	'alt!': '!in',
	'count!': '!count'
};


/**
 * Parse URL query parameters used for collection search requests into a fetch
 * DBO query specification.
 *
 * @function module:x2node-ws-resources.parseSearchQuery
 * @param {module:x2node-records~RecordTypeDescriptor} recordTypeDesc Descriptor
 * of the record type being queried.
 * @param {Object} urlQuery URL query parameters.
 * @param {string} queryParts Query parts to include in parsing. A line of
 * characters including "p", "f", "o" and "r".
 * @param {Object.<string,*>} queryParams Fetch query parameters to populate.
 * @returns {Object} Fetch DBO query specification, or <code>null</code> if
 * invalid URL query parameters.
 * @throws {common.X2SyntaxError} If query parameters are invalid.
 */
function parseSearchQuery(recordTypeDesc, urlQuery, queryParts, queryParams) {

	// query spec object to build
	const querySpec = new Object();

	// parse properties spec
	if ((queryParts.indexOf('p') >= 0) && urlQuery.p)
		querySpec.props = (
			Array.isArray(urlQuery.p) ? urlQuery.p.join(',') : urlQuery.p
		).split(',');

	// parse filter spec
	if (queryParts.indexOf('f') >= 0) {
		const filter = parseFilterParams(
			recordTypeDesc, 'f', ':and', urlQuery, queryParams, new Set());
		querySpec.filter = (filter ? filter[1] : new Array());
	}

	// parse order spec
	if ((queryParts.indexOf('o') >= 0) && urlQuery.o)
		querySpec.order = (
			Array.isArray(urlQuery.o) ? urlQuery.o.join(',') : urlQuery.o
		).split(',').map(oElement => parseQueryPropRef(
			recordTypeDesc, oElement, ORDER_OPS_MAPPING).spec);

	// parse range spec
	if ((queryParts.indexOf('r') >= 0) && urlQuery.r) {
		if (Array.isArray(urlQuery.r))
			throw new common.X2SyntaxError('More than one range specification.');
		querySpec.range = urlQuery.r.split(',').map(v => Number(v));
	}

	// return parsed query spec
	return querySpec;
}

/**
 * Parse filter query string parameters and build filter specfication.
 *
 * @private
 * @param {module:x2node-records~PropertiesContainer} baseContainer Base
 * container for the property references.
 * @param {string} groupId Filter group id.
 * @param {string} junc Filter group elements junction type.
 * @param {Object.<string,(string|Array.<string>)>} urlQuery Parsed query
 * string parameters object.
 * @param {Object.<string,*>} queryParams Fetch query parameters to populate.
 * @param {Set.<string>} parentGroupIds Parent group ids for circular group
 * references check.
 * @returns {Array} Filter specification.
 * @throws {common.X2SyntaxError} If the query string parameters are invalid.
 */
function parseFilterParams(
	baseContainer, groupId, junc, urlQuery, queryParams, parentGroupIds) {

	// check if valid group id
	if (groupId.length === 0)
		throw new common.X2SyntaxError('Empty nested group id.');

	// check for filter group reference loops
	if (parentGroupIds.has(groupId))
		throw new common.X2SyntaxError('Circular filter group reference.');

	// prefix for filter parameters that belong to the group
	const groupParamsPrefix = groupId + '$';

	// id for generated query parameters
	let nextQueryParamId = 0;

	// collect and process all filter group parameters
	const members = new Array();
	for (let paramName of Object.keys(urlQuery)) {

		// check if parameter belongs to the group
		if (!paramName.startsWith(groupParamsPrefix))
			continue;

		// extract the value and reference expressions
		const refExpr = paramName.substring(groupParamsPrefix.length);
		const paramVal = urlQuery[paramName];
		const valExprs = (Array.isArray(paramVal) ? paramVal : [ paramVal ]);

		// process each parameter
		for (let valExpr of valExprs) {

			// check if nested group
			if (refExpr.startsWith(':')) {

				// determing the nested group junction type
				let nestedJunc;
				switch (refExpr) {
				case ':or':
					nestedJunc = ':or';
					break;
				case ':or!':
					nestedJunc = ':!or';
					break;
				case ':and':
					nestedJunc = ':and';
					break;
				case ':and!':
					nestedJunc = ':!and';
					break;
				default:
					throw new common.X2SyntaxError(
						`Invalid junction type "${refExpr}"` +
							` in filter group "${groupId}".`);
				}

				// create nested group
				parentGroupIds.add(groupId);
				const nestedGroup = parseFilterParams(
					baseContainer, valExpr, nestedJunc, urlQuery,
					queryParams, parentGroupIds);
				parentGroupIds.delete(groupId);
				if (nestedGroup)
					members.push(nestedGroup);

			} else { // not a nested group

				// parse the predicate
				const hasValue = (valExpr.length > 0);
				const pred = parseQueryPropRef(
					baseContainer, refExpr, FILTER_OPS_MAPPING, hasValue);

				// check if has value
				if (hasValue) {

					// check if collection test
					if (!pred.propDesc.isScalar()) {

						// start building member specification
						const memberSpec = [ pred.spec ];

						// process count param value and get the nested group
						let nestedGroupId;
						if (pred.spec.endsWith('count')) {
							const valExprParts = valExpr.split(':');
							if (valExprParts.length > 2)
								throw new common.X2SyntaxError(
									'Invalid "count" filter parameter' +
										' value: more than 2' +
										' colon-separated values.');
							const countVal = Number(valExprParts[0]);
							if (!Number.isInteger(countVal))
								throw new common.X2SyntaxError(
									'Invalid "count" filter parameter' +
										' value: the count is not an integer.'
								);
							memberSpec.push(countVal);
							nestedGroupId = valExprParts[1];
						} else {
							nestedGroupId = valExpr;
						}

						// create nested group
						let nestedGroup;
						if (nestedGroupId) {
							parentGroupIds.add(groupId);
							nestedGroup = parseFilterParams(
								pred.propDesc.nestedProperties, nestedGroupId,
								':and', urlQuery, queryParams, parentGroupIds);
							parentGroupIds.delete(groupId);
						}

						// add nested group filter to the member
						if (nestedGroup)
							memberSpec.push([ nestedGroup ]);

						// add the test to the group members
						members.push(memberSpec);

					} else {  // not a collection test with value

						// get the filter parameter value
						let filterParamValue;
						if (pred.multi) {
							filterParamValue = valExpr.split('|').map(
								v => valueToQueryParam(v, pred));
						} else { // single value
							filterParamValue = valueToQueryParam(valExpr, pred);
						}

						// query parameter name
						const queryParamName =
							`p${groupId}${nextQueryParamId++}`;

						// add to query parameters
						queryParams[queryParamName] = filterParamValue;

						// add test to the group members
						members.push([ pred.spec, dbos.param(queryParamName) ]);
					}

				} else { // no value
					if (pred.requiresValue)
						throw new common.X2SyntaxError(
							`filter "${refExpr}" requires a value.`);
					members.push([ pred.spec ]);
				}
			}
		}
	}

	// return the result
	return (members.length > 0 ? [ junc, members ] : undefined);
}

/**
 * Convert filter query string parameter value to DBO query parameter value.
 *
 * @private
 * @param {string} val Value from the query string.
 * @param {Object} pred Descriptor of the parameter, for which to convert the
 * value.
 * @returns {*} Converted value.
 * @throws {common.X2SyntaxError} If the value is invalid.
 */
function valueToQueryParam(val, pred) {

	let res;
	switch (pred.valueType) {
	case 'string':
		if (pred.refPrefix && val.startsWith(pred.refPrefix)) {
			res = val.substring(pred.refPrefix.length);
		} else {
			res = val;
		}
		break;
	case 'number':
		if (pred.refPrefix && val.startsWith(pred.refPrefix)) {
			res = Number(val.substring(pred.refPrefix.length));
		} else {
			res = Number(val);
		}
		if (!Number.isFinite(res))
			throw new common.X2SyntaxError(
				'Invalid test value, expected a number.');
		break;
	case 'boolean':
		switch (val) {
		case 'true':
			res = true;
			break;
		case 'false':
			res = false;
			break;
		default:
			throw new common.X2SyntaxError(
				'Invalid test value, expected "true" or "false".');
		}
		break;
	case 'datetime':
		res = new Date(val);
		if (Number.isNaN(res.getTime()))
			throw new common.X2SyntaxError(
				'Invalid test value, expected a valid datetime.');
		res = res.toISOString();
		break;
	case '$pattern':
		try {
			res = new RegExp(val);
		} catch (err) {
			throw new common.X2SyntaxError(
				'Invalid test value, expected a valid regular expression.');
		}
		res = res.source;
		break;
	default:
		throw new Error(
			`Internal X2 error: unexpected query parameter value type` +
				` ${pred.valueType}.`);
	}

	return res;
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
function parseQueryPropRef(baseContainer, propRef, opsMapping, hasValue) {

	const error = msg => new common.X2SyntaxError(
		`Invalid expression "${propRef}": ${msg}`);

	const invert = propRef.endsWith('!');
	if (invert)
		propRef = propRef.substring(0, propRef.length - 1);

	const propRefParts = propRef.split(':');

	let propDesc, spec, valueType, collection = false, refPrefix, opRef;
	for (let i = 0, len = propRefParts.length; i < len; i++) {
		const propRefPart = propRefParts[i];

		if (i === 0) {

			spec = propRefPart;

			let container = baseContainer;
			for (let propName of propRefPart.split('.')) {
				if (!container || !container.hasProperty(propName))
					throw error('invalid property path.');
				if (collection)
					throw error('non-scalar intermediate.');
				propDesc = container.getPropertyDesc(propName);
				if (!propDesc.isScalar())
					collection = true;
				if (propDesc.isRef()) {
					const targetDesc = propDesc.nestedProperties;
					valueType = targetDesc.getPropertyDesc(
						targetDesc.idPropertyName).scalarValueType;
					refPrefix = targetDesc.name + '#';
				} else {
					valueType = propDesc.scalarValueType;
				}
				container = propDesc.nestedProperties;
			}

			if ((valueType === 'object') && !collection)
				throw error('nested object used for non-collection test.');

		} else {

			let arg1, arg2, dropRef = true;

			if (collection) {

				if (propRefPart === 'count') {
					opRef = propRefPart;
					if (i < len - 1)
						throw error('"count" must be the only operation.');
				} else {
					throw error('transformation or operation on a non-scalar.');
				}

			} else switch (propRefPart) {

			case 'len':
				if (valueType !== 'string')
					throw error('transformation "len" expects string input.');
				spec = `length(${spec})`;
				valueType = 'number';
				break;

			case 'lc':
				if (valueType !== 'string')
					throw error('transformation "lc" expects string input.');
				spec = `lower(${spec})`;
				valueType = 'string';
				break;

			case 'sub':
				if (valueType !== 'string')
					throw error('transformation "sub" expects string input.');
				if (i + 2 >= len)
					throw error('transformation "sub" expects two arguments.');
				arg1 = Number(propRefParts[++i]);
				if (!Number.isInteger(arg1) || (arg1 < 0))
					throw error(
						'transformation "sub" expects positive' +
							' integer first argument.');
				arg2 = propRefParts[++i];
				if (arg2.length > 0) {
					arg2 = Number(arg2);
					if (!Number.isInteger(arg2) || (arg2 < 0))
						throw error(
							'transformation "sub" expects empty or' +
								' positive integer second argument.');
					spec = `substring(${spec}, ${arg1}, ${arg2})`;
				} else {
					spec = `substring(${spec}, ${arg1})`;
				}
				valueType = 'string';
				break;

			case 'lpad':
				if (valueType !== 'string')
					throw error('transformation "lpad" expects string input.');
				if (i + 2 >= len)
					throw error('transformation "lpad" expects two arguments.');
				arg1 = Number(propRefParts[++i]);
				if (!Number.isInteger(arg1) || (arg1 < 0))
					throw error(
						'transformation "lpad" expects positive' +
							' integer first argument.');
				arg2 = propRefParts[++i];
				if (arg2.length === 0)
					arg2 = ' ';
				else if (arg2.length > 1)
					throw error(
						'transformation "lpad" expects empty or' +
							' single character second argument.');
				spec = `lpad(${spec}, ${arg1}, "${arg2}")`;
				valueType = 'string';
				break;

			default:
				if (i < len - 1)
					throw error('unknown transformation.');
				opRef = propRefPart;
				dropRef = false;
			}

			if (dropRef)
				refPrefix = undefined;
		}
	}

	let op;
	if (opRef) {
		if (invert)
			opRef += '!';
		op = opsMapping[opRef];
		if (!op)
			throw error('unknown operation.');
	} else {
		opRef = '$default';
		if (collection)
			opRef += ':collection';
		if (hasValue)
			opRef += ':value';
		if (invert)
			opRef += '!';
		op = opsMapping[opRef];
		if (!op)
			throw error('this type of expression is not allowed.');
	}

	return {
		propDesc: propDesc,
		spec: `${spec} => ${op}`,
		valueType: (opRef.startsWith('pat') ? '$pattern' : valueType),
		refPrefix: refPrefix,
		multi: (opRef.startsWith('alt')),
		requiresValue: !opRef.startsWith('$default')
	};
}

// export the parser function
exports.parseSearchQuery = parseSearchQuery;
