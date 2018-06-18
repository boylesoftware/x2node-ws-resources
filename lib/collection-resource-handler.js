'use strict';

const common = require('x2node-common');
const ws = require('x2node-ws');
const dbos = require('x2node-dbos');
const validators = require('x2node-validators');

const AbstractResourceHandler = require('./abstract-resource-handler.js');


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
	'min!': 'lt',
	'max!': 'gt',
	'pat!': '!matchesi',
	'mid!': '!containsi',
	'pre!': '!startsi',
	'alt!': '!in'
};


/**
 * Standard collection resource web wervice endpoint handler.
 *
 * @memberof module:x2node-ws-resources
 * @extends module:x2node-ws-resources~AbstractResourceHandler
 * @implements module:x2node-ws.Handler
 */
class CollectionResourceHandler extends AbstractResourceHandler {

	/**
	 * Create new handler.
	 *
	 * @param {module:x2node-dbos.DataSource} ds Data source.
	 * @param {module:x2node-dbos~DBOFactory} dboFactory DBO factory.
	 * @param {string} rsrcPath Resource path.
	 * @param {Object} [options] Options.
	 */
	constructor(ds, dboFactory, rsrcPath, options) {
		super(ds, dboFactory, rsrcPath, options);

		// reusable DBO for fetching new record after POST
		this._newRecordFetchDBO = dboFactory.buildFetch(
			this._recordTypeName, {
				filter: [
					[ this._recordTypeDesc.idPropertyName, dbos.param('id') ]
				]
			});
	}

	/**
	 * Default implementation for the <code>isAllowed()</code> method that calls
	 * handler's <code>isAllowedAction()</code> method.
	 *
	 * @private
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @returns {boolean} The <code>isAllowedAction()</code> method call result.
	 */
	_defaultIsAllowed(call) {

		let action;
		switch (call.method) {
		case 'GET':
			action = 'search';
			break;
		case 'POST':
			action = 'create';
		}

		return this.isAllowedAction(action, call.actor, call);
	}

	/////////////////////////////////////////////////////////////////////////////
	// process GET call
	/////////////////////////////////////////////////////////////////////////////
	GET(call) {

		// transaction context
		const txCtx = this._createTransactionContext(call);

		// create query specification
		txCtx.queryParams = new Object();
		try {

			// parse query string
			txCtx.querySpec = this._parseQuery(
				call.requestUrl.query, txCtx.queryParams);

			// add uplink filters
			this._addUplinkFilters(
				call, -1, txCtx.querySpec.filter, txCtx.queryParams);

		} catch (err) {
			if (err instanceof common.X2SyntaxError) {
				return ws.createResponse(400).setEntity({
					errorCode: 'X2-RSRC-400-1',
					errorMessage: 'Invalid query string: ' + err.message
				});
			}
			throw err;
		}

		// pre-resolve response promise
		let responsePromise = Promise.resolve();

		// custom preparation logic
		if ((typeof this.prepareSearch) === 'function')
			responsePromise = responsePromise.then(() => Promise.resolve(
				this._callHook('prepareSearch', txCtx)
			));

		// build the search DBO and determine collection locks
		let searchDBO, collectionsInVersion;
		responsePromise = responsePromise.then(() => {

			// build search DBO
			// TODO: cache search DBO
			let searchDBO;
			try {
				searchDBO = this._dboFactory.buildFetch(
					this._recordTypeName, txCtx.querySpec);
			} catch (err) {
				if (err instanceof common.X2SyntaxError) {
					return Promise.reject(ws.createResponse(400).setEntity({
						errorCode: 'X2-RSRC-400-1',
						errorMessage: 'Invalid query string: ' + err.message
					}));
				}
				return Promise.reject(err);
			}

			// create initial specification for collections locks
			txCtx.collectionLocks = {
				shared: Array.from(searchDBO.involvedRecordTypeNames)
			};
			collectionsInVersion = searchDBO.involvedRecordTypeNames;
		});

		// proceed to the transaction
		responsePromise = responsePromise.then(() => {

			// assemble transaction phases
			const txPhases = new Array();

			// custom tx setup hook
			if ((typeof this.beforeSearchTx) === 'function')
				txPhases.push((_, txCtx) => this._callHook(
					'beforeSearchTx', txCtx));

			// lock collections and get their version info
			const rcMonitor = this._dboFactory.recordCollectionsMonitor;
			if (rcMonitor)
				txPhases.push((tx, txCtx) => rcMonitor.lockCollections(
					tx, txCtx.collectionLocks, collectionsInVersion
				).then(versionInfo => this._processConditions(
					txCtx, versionInfo
				)));

			// custom "before" hook
			if ((typeof this.beforeSearch) === 'function')
				txPhases.push((_, txCtx) => this._callHook(
					'beforeSearch', txCtx));

			// main action
			txPhases.push((tx, txCtx) => searchDBO.execute(
				tx, call.actor, txCtx.queryParams));

			// custom "after" hook
			if ((typeof this.afterSearch) === 'function')
				txPhases.push((_, txCtx, result) => this._callHook(
					'afterSearch', txCtx, result));

			// execute the transaction
			return this._executeTransaction(txCtx, txPhases);
		});

		// custom completion logic
		if ((typeof this.completeSearch) === 'function')
			responsePromise = responsePromise.then(
				result => Promise.resolve(
					txCtx.complete ? result
					: this._callHook('completeSearch', undefined, txCtx, result)
				),
				err => Promise.reject(
					this._callHook('completeSearch', err, txCtx, undefined)
				)
			);

		// build and return the response promise
		return responsePromise.then(result => {

			// check if already a response
			if (ws.isResponse(result))
				return result;

			// create and return respose
			return this._addValidatorHeaders(txCtx, ws.createResponse(200))
				.setEntity(result);
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
			querySpec.props = (
				Array.isArray(urlQuery.p) ? urlQuery.p.join(',') : urlQuery.p
			).split(',');

		// parse filter spec
		const filter = this._parseFilterParams(
			this._recordTypeDesc, 'f', ':and', urlQuery, queryParams, new Set());
		querySpec.filter = (filter ? filter[1] : new Array());

		// parse order spec
		if (urlQuery.o)
			querySpec.order = (
				Array.isArray(urlQuery.o) ? urlQuery.o.join(',') : urlQuery.o
			).split(',').map(oElement => this._parseQueryPropRef(
				this._recordTypeDesc, oElement, ORDER_OPS_MAPPING).spec);

		// parse range spec
		if (urlQuery.r) {
			if (Array.isArray(urlQuery.r))
				throw new common.X2SyntaxError(
					'More than one range specification.');
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
	_parseFilterParams(
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
					const nestedGroup = this._parseFilterParams(
						baseContainer, valExpr, nestedJunc, urlQuery,
						queryParams, parentGroupIds);
					parentGroupIds.delete(groupId);
					if (nestedGroup)
						members.push(nestedGroup);

				} else { // not a nested group

					// parse the predicate
					const hasValue = (valExpr.length > 0);
					const pred = this._parseQueryPropRef(
						baseContainer, refExpr, FILTER_OPS_MAPPING, hasValue);

					// check if has value
					if (hasValue) {

						// check if collection test
						if (!pred.propDesc.isScalar()) {

							// create nested group
							parentGroupIds.add(groupId);
							const nestedGroup = this._parseFilterParams(
								pred.propDesc.nestedProperties, valExpr, ':and',
								urlQuery, queryParams, parentGroupIds);
							parentGroupIds.delete(groupId);

							// add the test to the group members
							if (nestedGroup) {
								members.push([ pred.spec, [ nestedGroup ] ]);
							} else {
								members.push([ pred.spec ]);
							}

						} else {  // not a collection test with value

							// get the filter parameter value
							let filterParamValue;
							if (pred.multi) {
								filterParamValue = valExpr.split('|').map(
									v => this._valueToQueryParam(v, pred));
							} else { // single value
								filterParamValue = this._valueToQueryParam(
									valExpr, pred);
							}

							// query parameter name
							const queryParamName =
								`p${groupId}${nextQueryParamId++}`;

							// add to query parameters
							queryParams[queryParamName] = filterParamValue;

							// add test to the group members
							members.push(
								[ pred.spec, dbos.param(queryParamName) ]);
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
	_valueToQueryParam(val, pred) {

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
	_parseQueryPropRef(baseContainer, propRef, opsMapping, hasValue) {

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

				if (collection)
					throw error('transformation or operation on a non-scalar.');

				let arg1, arg2, dropRef = true;
				switch (propRefPart) {

				case 'len':
					if (valueType !== 'string')
						throw error(
							'transformation "len" expects string input.');
					spec = `length(${spec})`;
					valueType = 'number';
					break;

				case 'lc':
					if (valueType !== 'string')
						throw error(
							'transformation "lc" expects string input.');
					spec = `lower(${spec})`;
					valueType = 'string';
					break;

				case 'sub':
					if (valueType !== 'string')
						throw error(
							'transformation "sub" expects string input.');
					if (i + 2 >= len)
						throw error(
							'transformation "sub" expects two arguments.');
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
						throw error(
							'transformation "lpad" expects string input.');
					if (i + 2 >= len)
						throw error(
							'transformation "lpad" expects two arguments.');
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

	/////////////////////////////////////////////////////////////////////////////
	// process POST call
	/////////////////////////////////////////////////////////////////////////////
	POST(call) {

		// transaction context
		const txCtx = this._createTransactionContext(call);
		txCtx.recordTmpl = call.entity;

		// make sure that we have the entity
		if (!txCtx.recordTmpl)
			return ws.createResponse(400).setEntity({
				errorCode: 'X2-RSRC-400-2',
				errorMessage: 'Expected record data in the request entity.'
			});

		// pre-resolve response promise
		let responsePromise = Promise.resolve();

		// custom record template modification logic
		if ((typeof this.prepareCreateSpec) === 'function')
			responsePromise = responsePromise.then(() => Promise.resolve(
				this._callHook('prepareCreateSpec', txCtx, txCtx.recordTmpl)));

		// validate the record data
		responsePromise = responsePromise.then(() => {
			const errors = validators.normalizeRecord(
				this._recordTypes, this._recordTypeName, txCtx.recordTmpl,
				call.httpRequest.headers['Accept-Language'], 'onCreate');
			if (errors)
				return Promise.reject(ws.createResponse(400).setEntity({
					errorCode: 'X2-RSRC-400-3',
					errorMessage: 'Invalid record data.',
					validationErrors: errors
				}));
		});

		// build specification for the parent record fetch DBO
		if (this._uplinkChain.length > 0) {
			responsePromise = responsePromise.then(() => {
				txCtx.parentQueryParams = new Object();
				txCtx.parentQuerySpec = this._buildParentRecordFetchQuerySpec(
					call, txCtx.recordTmpl, txCtx.parentQueryParams);
			});
		}

		// custom preparation logic
		if ((typeof this.prepareCreate) === 'function')
			responsePromise = responsePromise.then(() => Promise.resolve(
				this._callHook('prepareCreate', txCtx, txCtx.recordTmpl)));

		// validate immediate uplink value, if any
		if (this._uplinkChain.length > 0) {
			const uplink = this._uplinkChain[0];
			if (uplink.uriParamOffset !== null)
				responsePromise = responsePromise.then(() => {
					const expectedValue =
						uplink.recordTypeDesc.name + '#' +
						uplink.value(call.uriParams[call.uriParams.length - 1]);
					if (txCtx.recordTmpl[uplink.propPath] !== expectedValue)
						return Promise.reject(ws.createResponse(400).setEntity({
							errorCode: 'X2-RSRC-400-7',
							errorMessage:
								'Record data does not match the resource URI.'
						}));
				});
		}

		// determine collection locks
		let collectionsInVersion;
		responsePromise = responsePromise.then(() => {
			txCtx.collectionLocks = {
				exclusive: [ this._recordTypeName ]
			};
			collectionsInVersion = [ this._recordTypeName ];
		});

		// proceed to the transaction
		const idPropName = this._recordTypeDesc.idPropertyName;
		const responseType = this._options.post.response;
		responsePromise = responsePromise.then(() => {

			// assemble transaction phases
			const txPhases = new Array();

			// custom tx setup hook
			if ((typeof this.beforeCreateTx) === 'function')
				txPhases.push((_, txCtx) => this._callHook(
					'beforeCreateTx', txCtx));

			// fetch, lock and check parent record, if any
			if (this._uplinkChain.length > 0)
				txPhases.push((tx, txCtx) => this._dboFactory.buildFetch(
					this._uplinkChain[0].recordTypeDesc.name,
					txCtx.parentQuerySpec
				).execute(
					tx, call.actor, txCtx.parentQueryParams
				).then(result => {
					const numRecs = result.records;
					if (numRecs.length > 1)
						return Promise.reject(new common.X2DataError(
							'More than one parent record.'));
					if (numRecs.length === 0)
						return tx.commit().then(() => Promise.reject(
							ws.createResponse(404).setEntity({
								errorCode: 'X2-RSRC-404-2',
								errorMessage: 'Parent record not found.'
							})
						));
					txCtx.parentRecord = result.records[0];
				}));

			// lock collection in exclusive mode, process conditional request
			const rcMonitor = this._dboFactory.recordCollectionsMonitor;
			if (rcMonitor)
				txPhases.push((tx, txCtx) => rcMonitor.lockCollections(
					tx, txCtx.collectionLocks, collectionsInVersion
				).then(versionInfo => (
					this._isConditionalRequest(call) &&
						this._processConditions(txCtx, versionInfo)
				)));

			// custom "before" hook
			if ((typeof this.beforeCreate) === 'function')
				txPhases.push((_, txCtx) => this._callHook(
					'beforeCreate', txCtx, txCtx.recordTmpl));

			// create insert DBO and execute the main action
			txPhases.push((tx, txCtx) => this._dboFactory.buildInsert(
				this._recordTypeName, txCtx.recordTmpl
			).execute(tx, call.actor));

			// fetch the new record if configured
			if ((responseType === undefined) || (responseType === 'record'))
				txPhases.push(
					(tx, txCtx, recordId) => this._newRecordFetchDBO.execute(
						tx, call.actor, {
							id: recordId
						}).then(result => result.records[0])
				);
			else
				txPhases.push(
					(tx, txCtx, recordId) => {
						txCtx.recordTmpl[idPropName] = recordId;
						return Promise.resolve(txCtx.recordTmpl);
					}
				);

			// custom "after" hook
			if ((typeof this.afterCreate) === 'function')
				txPhases.push((_, txCtx, record) => this._callHook(
					'afterCreate', txCtx, record));

			// execute the transaction
			return this._executeTransaction(txCtx, txPhases);
		});

		// custom completion logic
		if ((typeof this.completeCreate) === 'function')
			responsePromise = responsePromise.then(
				result => Promise.resolve(
					txCtx.complete ? result
					: this._callHook('completeCreate', undefined, txCtx, result)
				),
				err => Promise.reject(
					this._callHook('completeCreate', err, txCtx, undefined)
				)
			);

		// prepare the response
		switch (responseType) {

		case 'status':
		case 'redirect':
			responsePromise = responsePromise.then(result => {
				if (txCtx.complete)
					return result;
				const location = call.requestUrl.pathname + '/' +
					encodeURIComponent(result[idPropName]);
				return ws.createResponse(responseType === 'redirect' ? 303 : 201)
					.setHeader('Location', location)
					.setEntity(new Buffer(`<!DOCTYPE html>
<html lang="en">
  <head><title>${this._recordTypeName} Created</title></head>
  <body>Location: <a href="${location}">${location}</a></body>
<html>`, 'utf8'), 'text/html; charset=UTF-8');
			});

			break;

		default: // new record in the body
			responsePromise = responsePromise.then(result => {
				if (txCtx.complete)
					return result;
				const location = call.requestUrl.pathname + '/' +
					encodeURIComponent(result[idPropName]);
				const videsc = this._getRecordVersionInfo(call, result);
				this._saveValidatorHeaders(
					txCtx, videsc.etag, videsc.lastModified);
				return this._addValidatorHeaders(
					txCtx, ws.createResponse(201)
						.setHeader('Location', location)
						.setHeader('Content-Location', location)
						.setEntity(result));
			});
		}

		// return the response promise
		return responsePromise;
	}

	/**
	 * Build query specification for the fetch DBO that gets the parent record id
	 * based on the uplink URI parameters and used to check parent records
	 * existence. Also locks parent records in share mode.
	 *
	 * @private
	 * @param {module:x2node-ws~ServiceCall} call The call.
	 * @param {Object} record The record.
	 * @param {Object.<string,*>} queryParams Query parameters object that is
	 * populated by this method.
	 * @returns {Object} Query specification for the fetch DBO.
	 */
	_buildParentRecordFetchQuerySpec(call, record, queryParams) {

		const filter = new Array();
		const uriParams = call.uriParams;
		const lastUplinkParamInd = uriParams.length - 1;
		for (let i = 0, len = this._uplinkChain.length; i < len; i++) {
			const uplink = this._uplinkChain[i];
			if ((uplink.uriParamOffset === null) && (i === 0)) {
				const idString = record[uplink.propPath].substring(
					uplink.recordTypeDesc.name.length + 1);
				const idPropDesc = uplink.recordTypeDesc.getPropertyDesc(
					uplink.recordTypeDesc.idPropertyName);
				queryParams['pid'] = (
					idPropDesc.scalarValueType === 'number' ?
						Number(idString) : idString);
				filter.push([
					uplink.recordTypeDesc.idPropertyName,
					dbos.param('pid')
				]);
			} else {
				const uriParamInd = lastUplinkParamInd + uplink.uriParamOffset;
				const paramName = 'uri' + uriParamInd;
				queryParams[paramName] = uplink.value(uriParams[uriParamInd]);
				filter.push([
					(
						i > 0 ?
							uplink.propPath.substring(
								uplink.propPath.indexOf('.') + 1) :
							uplink.recordTypeDesc.idPropertyName
					),
					dbos.param(paramName)
				]);
			}
		}

		return {
			props: [],
			filter: filter,
			lock: 'shared'
		};
	}

	/////////////////////////////////////////////////////////////////////////////
	// common methods
	/////////////////////////////////////////////////////////////////////////////

	/**
	 * Process conditional request and determine values for the "ETag" and
	 * "Last-Modified" HTTP response headers.
	 *
	 * @private
	 * @param {module:x2node-ws-resources~TransactionContext} txCtx Transaction
	 * context.
	 * @param {module:x2node-dbos.RecordCollectionsMonitor~VersionInfo} versionInfo
	 * Aggregate version information for the record collections that participate
	 * in forming the response.
	 * @returns {*} Response to return immediately (the transaction is complete),
	 * or nothing to continue the transaction.
	 */
	_processConditions(txCtx, versionInfo) {

		// build the ETag and Last-Modified
		const etag =
			  '"' + txCtx.call.apiVersion +
			  ':' + String(txCtx.call.actor ? txCtx.call.actor.id : '*') +
			  ':' + versionInfo.version + '"';
		const lastModified = versionInfo.modifiedOn;

		// evaluate preconditions
		const response = this._evaluatePreconditions(
			txCtx.call, etag, lastModified);
		if (response) {
			txCtx.makeComplete();
			return response;
		}

		// set the ETag and Last-Modified on the transaction context
		this._saveValidatorHeaders(txCtx, etag, lastModified);
	}
}

// export the class
module.exports = CollectionResourceHandler;
