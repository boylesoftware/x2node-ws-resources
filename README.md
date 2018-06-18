# X2 Framework for Node.js | Persistent Resources

For those who use _X2 Framework_ to create web-services that expose RESTful API and are backed by a SQL database, this module is the "pinnacle" that integrates all other major modules that comprise the framework into the application. In its essence, the module provides basic, extendable API endpoint handler implementations for [x2node-ws](https://www.npmjs.com/package/x2node-ws) that use [x2node-dbos](https://www.npmjs.com/package/x2node-dbos) to access records in the backend SQL database. Given a record type defined using [x2node-records](https://www.npmjs.com/package/x2node-records) module and mapped to the database for use by the DBOs module, this module provides two API endpoint handler implementations for two types of endpoints associated with the record type (or _persistent resource_ in the terminology used by the module):

* _Records Collection Endpoint_ - the endpoint that represents the collection of all records of the given type as a whole and allows such operations as searching the collection (via the HTTP `GET` method) and creating new records (via the HTTP `POST` method).

* _Individual Record Endpoint_ - the endpoint that is usually mapped to a URI that includes the record id and is used to perform actions on an individual record identified by the id. The actions include getting the record data (via the HTTP `GET` method), updating the record (via the HTTP `PATCH` method) and deleting the record (via the HTTP `DELETE` method).

Out of the box the handlers provided by the module include all the essential functionality expected from a production-ready web-service application, including [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Access_control_CORS), conditional HTTP requests with _ETag_ and _Last-Modified_ headers (see [RFC 7232](https://tools.ietf.org/html/rfc7232)), submitted data validation, transactions, etc. Also, the handlers provide numerous plug-in points for application-supplied "hooks" where custom logic can be implemented to extend the basic framework.

It is recommended that whoever plans to use this module first becomes familiar with the [x2node-ws](https://www.npmjs.com/package/x2node-ws), [x2node-dbos](https://www.npmjs.com/package/x2node-dbos) and [x2node-records](https://www.npmjs.com/package/x2node-records) modules.

See module's [API Reference Documentation](https://boylesoftware.github.io/x2node-api-reference/module-x2node-ws-resources.html).

## Table of Contents

* [Usage](#usage)
* [Dependent Resources](#dependent-resources)
* [Conditional Requests Support](#conditional-requests-support)
* [Endpoints and Operations](#endpoints-and-operations)
  * [Record Search](#record-search)
    * [Records Filter](#records-filter)
    * [Included Record Properties](#included-record-properties)
    * [Records Order](#records-order)
    * [Records Range](#records-range)
    * [The Result Object](#the-result-object)
  * [Record Read](#record-read)
  * [Record Creation](#record-creation)
  * [Record Update](#record-update)
  * [Record Delete](#record-delete)
* [Handler Extensions](#handler-extensions)
  * [General Handler Configuration Hooks](#general-handler-configuration-hooks)
  * [Handler Transaction Hooks](#handler-transaction-hooks)
    * [Transaction Context](#transaction-context)
    * [Record Search Hooks](#record-search-hooks)
    * [Record Read Hooks](#record-read-hooks)
    * [Record Creation Hooks](#record-creation-hooks)
    * [Record Update Hooks](#record-update-hooks)
    * [Record Delete Hooks](#record-delete-hooks)
* [Miscellaneous](#miscellaneous)
  * [Auto-Assigned Properties](#auto-assigned-properties)

## Usage

Here is an example of a complete web-service application that backs a simplified online store and provides API endpoints for _Accounts_, _Products_ and _Orders_:

```javascript
// let's use MySQL in this example
const mysql = require('mysql');

// load the framework modules
const records = require('x2node-records');
const dbos = require('x2node-dbos');
const rcMonitor = require('x2node-dbos-monitor-dbtable');
const ws = require('x2node-ws');
const resources = require('x2node-ws-resources');

// create the database connection pool
const pool = mysql.createPool({
    connectionLimit: 10,
    host: process.env['DB_HOST'],
    port: process.env['DB_PORT'] || 3306,
    database: process.env['DB_NAME'],
    user: process.env['DB_USER'],
    password: process.env['DB_PASSWORD'],
    timezone: '+00:00'
});

// build the record types library
const recordTypes = records.with(dbos).buildLibrary({
    recordTypes: {
        'Account': {
            table: 'accounts',
            properties: {
                'id': {
                    valueType: 'number',
                    role: 'id'
                },
                'version': {
                    valueType: 'number',
                    role: 'version'
                },
                'modifiedOn': {
                    valueType: 'datetime',
                    role: 'modificationTimestamp',
                    column: 'modified_on'
                },
                'firstName': {
                    valueType: 'string',
                    column: 'fname'
                },
                'lastName': {
                    valueType: 'string',
                    column: 'lname'
                },
                'orderRefs': {
                    valueType: 'ref(Order)[]',
                    reverseRefProperty: 'accountRef'
                }
            }
        },
        'Product': {
            table: 'products',
            properties: {
                'id': {
                    valueType: 'number',
                    role: 'id'
                },
                'version': {
                    valueType: 'number',
                    role: 'version'
                },
                'modifiedOn': {
                    valueType: 'datetime',
                    role: 'modificationTimestamp',
                    column: 'modified_on'
                },
                'name': {
                    valueType: 'string'
                },
                'price': {
                    valueType: 'number'
                }
            }
        },
        'Order': {
            table: 'orders',
            properties: {
                'id': {
                    valueType: 'number',
                    role: 'id'
                },
                'version': {
                    valueType: 'number',
                    role: 'version'
                },
                'modifiedOn': {
                    valueType: 'datetime',
                    role: 'modificationTimestamp',
                    column: 'modified_on'
                },
                'accountRef': {
                    valueType: 'ref(Account)',
                    column: 'account_id',
                    modifiable: false
                },
                'placedOn': {
                    valueType: 'datetime',
                    column: 'placed_on',
                    modifiable: false
                },
                'status': {
                    valueType: 'string'
                },
                'items': {
                    valueType: 'object[]',
                    table: 'order_items',
                    parentIdColumn: 'order_id',
                    properties: {
                        'id': {
                            valueType: 'number',
                            role: 'id'
                        },
                        'productRef': {
                            valueType: 'ref(Product)',
                            column: 'product_id',
                            modifiable: false
                        },
                        'quantity': {
                            valueType: 'number'
                        }
                    }
                }
            }
        }
    }
});

// create DBO factory
const dboFactory = dbos.createDBOFactory(recordTypes, 'mysql');

// create the data source for the database connections
const ds = dboFactory.adaptDataSource(pool);

// add record collections monitor to support "ETag" and "Last-Modified" headers
rcMonitor.assignTo(dboFactory, ds);

// create API endpoint handlers factory
const handlers = resources.createResourceHandlersFactory(ds, dboFactory);

// create, configure and run the application
ws.createApplication()
    .on('shutdown', () => {
        pool.end();
    })
    .addEndpoint(
        '/accounts',
        handlers.collectionResource('Contact')
    )
    .addEndpoint(
        '/accounts/([1-9][0-9]*)',
        handlers.individualResource('Contact')
    )
    .addEndpoint(
        '/products',
        handlers.collectionResource('Product')
    )
    .addEndpoint(
        '/products/([1-9][0-9]*)',
        handlers.individualResource('Product')
    )
    .addEndpoint(
        '/orders',
        handlers.collectionResource('Order')
    )
    .addEndpoint(
        '/orders/([1-9][0-9]*)',
        handlers.individualResource('Order')
    )
    .run(Number(process.env['HTTP_PORT']));
```

Besides the database schema, that's all that needs to be done.

Note that we leave user authentication and authorization beyond the scope of this simple example. For details on those topics see [x2node-ws](https://www.npmjs.com/package/x2node-ws) module.

The module's `createResourceHandlersFactory()` function can also take an optional third argument, an object with options passed down to the handlers it constructs. The options adjust the default behavior of the handlers and include:

* `post.response` - Determines the response sent back by the collection resource handler upon a successful `POST` request. The possible values include:

  * _record_ - This is the default. The new record created as a result of the `POST` call is re-read from the database at the end of the transaction and is returned in the HTTP 201 (Created) response body. The record includes everything returned in response to a `GET` request to the corresponding individual resource endpoint.

  * _status_ - An HTTP 201 (Created) response is sent back with a short HTML body describing the operation result. The response also includes a "Location" header with the new record URI, which is the collection resource endpoint URI plus the new record id.

  * _redirect_ - Same as _status_, but an HTTP 303 (See Other) response is returned.

* `patch.response` - Determines the response sent back by the individual resource handler upon successful `PATCH` request. The possible values include:

  * _record_ - This is the default. An HTTP 200 (OK) response is sent with the updated record in the response body. The record includes all the data that would be present in a response to a record `GET` request after the patch is applied.

  * _reread_ - The same as _record_, but the record is completely re-read from the database at the end of the transaction. This is slower than the _record_ mode, but makes absolutely sure that the record in the response body is the same as the one that would be returned in response to a `GET` request. The record data may be different from the data in the _record_ mode if, for example, the record includes some generated properties fetched by default.

  * _nocontent_ - An HTTP 204 (No Content) response is returned.

Other options can be included and passed down to the handlers. Those options are made available to the handler extensions described further down in this manual and may be used to configure the handlers' behavior.

The module uses `X2_APP` section for debug logging, which is the same as the [x2node-ws](https://www.npmjs.com/package/x2node-ws) module. Add it to `NODE_DEBUG` environment variable to see the debug messages (see [Node.js API docs](https://nodejs.org/docs/latest-v4.x/api/util.html#util_util_debuglog_section) for details).

## Dependent Resources

The record types library has a concept of dependent record types. Records of a dependent record type have a reference to a record of the parent record type and therefore can exist only in the context of the parent record. In the example used in the [Usage](#usage) section such record type is _Order_, because an _Order_ record can exist only in the context of an _Account_ record. No _Order_ record can exist without an _Account_, to which it belongs, which makes it dependent.

In the [Usage](#usage) section example the complete _Order_ records collection resource is mapped to an API endpoint, which often makes sense for admin applications that access the _Order_ records collection as a whole for all accounts. However, the end-user application being an agent of a particular account needs to access only a slice of the whole _Order_ records collection&mdash;those _Order_ records that belong to the account. For that, a contextualized API endpoint URI makes better sense:

```
/accounts/<account_id>/orders
/accounts/<account_id>/orders/<order_id>
```

The first argument to the handler factory's `collectionResource()` and `individualResource()` methods is not just a represented record type name as shown in the [Usage](#usage) section's example&mdash;it's what's called a `persistent resource path`, which allows to express a chain of dependent record types. The path is constructed from left to right starting with the top independent record type (_Account_ in our example) and ending with the dependent record type represented by the API endpoint (_Order_ in our example). Each path element maps to the record id part of the URI. The right-most element is just the record type name, all other elements are property paths in dot notation for the reference property pointing to the parent record. The path elements are separated by `<-`.

The endpoint mappings for the example above would look like the following:

```javascript
ws.createApplication()
    ...
    .addEndpoint(
        '/accounts/([1-9][0-9]*)/orders',
        handlers.collectionResource('accountRef<-Order')
    )
    .addEndpoint(
        '/accounts/([1-9][0-9]*)/orders/([1-9][0-9]*)',
        handlers.individualResource('accountRef<-Order')
    )
    ...
```

The framework will automatically include checks for the parent records existence when working with the dependent resource endpoint URIs.

Using dot notation, the resource paths can "jump" over several records. For example, if our online store were a multi-tenant system supporting multiple stores, the _Account_ records would include a `storeRef` property pointing back to the _Store_ record. Then we might want to have an API endpoint for the store admin application to manage the _Order_ records:

```
/stores/<store_id>/orders
/stores/<store_id>/orders/<order_id>
```

The mapping would be:

```javascript
ws.createApplication()
    ...
    .addEndpoint(
        '/stores/([1-9][0-9]*)/orders',
        handlers.collectionResource('accountRef.storeRef<-Order')
    )
    .addEndpoint(
        '/stores/([1-9][0-9]*)/orders/([1-9][0-9]*)',
        handlers.individualResource('accountRef.storeRef<-Order')
    )
    ...
```

Or, for the end-user application it would still be:

```javascript
ws.createApplication()
    ...
    .addEndpoint(
        '/stores/([1-9][0-9]*)/accounts/([1-9][0-9]*)/orders',
        handlers.collectionResource('storeRef<-accountRef<-Order')
    )
    .addEndpoint(
        '/stores/([1-9][0-9]*)/accounts/([1-9][0-9]*)/orders/([1-9][0-9]*)',
        handlers.individualResource('storeRef<-accountRef<-Order')
    )
    ...
```

## Conditional Requests Support

The handlers will automatically generate "ETag" and "Last-Modified" response headers that can be used by the clients for conditional HTTP requests (see [RFC 7232](https://tools.ietf.org/html/rfc7232)). To enable this functionality for the records collection handlers the DBO factory must be assigned a record collections monitor (see [x2node-dbos](https://www.npmjs.com/package/x2node-dbos) module). The example in the [Usage](#usage) section uses one such monitor implementation, which the [x2node-dbos-monitor-dbtable](https://www.npmjs.com/package/x2node-dbos-monitor-dbtable) module. For the individual record handlers the record types must include the corresponding meta-info properties _version_ and _modificationTimestamp_ also defined by the [x2node-dbos](https://www.npmjs.com/package/x2node-dbos) module.

The handlers fully support conditional requests and will return HTTP 304 (Not Modified) and HTTP 412 (Precondition Failed) responses accordingly. The use of this functionality is encouraged as it improves the efficiency and robustness of the web-service applications.

## Endpoints and Operations

As mentioned in the introduction, out-of-the-box the module provides handlers for two types of API endpoints: the records collection resource and the individual record resource. Each handles a set of HTTP methods that allow:

* Searching the collection of records of a given record type (HTTP `GET` on the records collection resource).

* Getting a record identified by id (HTTP `GET` on the individual record resource).

* Creating new record (HTTP `POST` on the records collection resource).

* Updating a record identified by id (HTTP `PATCH` on the individual record resource).

* Deleting a record identified by id (HTTP `DELETE` on the individual record resource).

A detailed description of each follows.

### Record Search

The collection resource handler's `GET` method implementation is used to perform searches on the corresponding record collections. What's returned in the response body is a JSON representation of the fetch DBO result object. The query for the fetch DBO is specified using request URL parameters.

#### Records Filter

The search filter is specified using URL query string parameters whose names start with prefix `f$`. Each such parameter follows the pattern `f$<test>=<value>` where `<test>` specifies what is tested and how and `<value>`, if the test requires it, represents the value, against which the test is performed (some tests do not need a value and simply take form of `f$<test>`).

The `<test>` part generally follows the pattern `<property_path>[:<value_func>[:<value_func>]...][:<test_type>]`. The property path is in dot notation to reach nested properties and jump over reference properties. Zero, one or more value transformation functions can perform operations on the property value such as taking the string length, transforming the string to lower case, etc. When multiple value transformation functions are specified their results are piped from one to another. And finally the test type determines how the value is tested. If test type is not provided, equality is tested if the parameter has value and non-emptiness is tested if the parameter has no value.

Here are some examples:

* `f$status=PENDING` - Select records that have property `status` equal "PENDING".
* `f$accountRef.firstName:pre=da` - Select records whose `accountRef` reference property points at account records that have `firstName` property that starts with "da" (`:pre` is the prefix test described below).
* `f$company` - Select records that have non-empty `company` property.
* `f$company!` - Select records that have empty `company` property.
* `f$email:lc=pat@example.com` - Select records that have `email` property transformed to lower case (`:lc` is the value transformation function described below) equal "pat@<span></span>example.com".
* `f$lastName:len:min=10` - Select records that have `lastName` property value at least 10 characters long (`:len` is a function and `:min` is the test).

The following tests are supported:

* `:min` - _Minimum value_. Test if the value is greater or equal to the parameter value.
* `:max` - _Maximum value_. Test if the value is less or equal to the parameter value.
* `:pat` - _Pattern_. Test if the value matches the regular expression provided as the parameter value. The test is case-insensitive.
* `:mid` - _Substring_. Test if the value contains the substring provided as the parameter value. The test is case-insensitive.
* `:pre` - _Prefix_. Test if the value starts with the string provided as the parameter value. The test is case-insensitive.
* `:alt` - _Alternatives_. Test if the value is one of the pipe-separated values provided as the parameter value.
* Nothing - _Equality_ or _Presence_. If no test is specified, test if the value is equal to the value provided as the parameter value. If the parameter does not have a value, test if the value is not empty.
* Any of the above can be followed with an exclamation point (for example `:min!`, `:pre!`, or simply `!` for the equality/presence test) to invert the test effect.

The following value transformation functions are supported:

* `:len` - Get string length.
* `:lc` - Transform string to all lower-case.
* `:sub:<start_index>:[<max_length>]` - Get substring starting with the `<start_index>` (zero-based) and maximum specified length (e.g. `f$name:sub:5:10`), or to the end of the string if no maximum length specified (e.g. `f$name:sub:5:`).
* `:lpad:<min_width>:[<padding_char>]` - Pad the string on the left with the specified padding character to achieve the specified minimum width (e.g. `f$name:lpad:30:x`). If no padding character is specified, space is used (e.g. `f$name:lpad:30:`).

Multiple URL query string parameters are combined with logical _AND_. For example:

* `f$status=PENDING&f$accountRef.lastName:len:min=5` - Select records whose `status` property is "PENDING" _and_ the referred account record's `lastName` property is at least 5 characters long.

It is possible to combine the tests using other logical operators. To do that, URL query string parameters in the format `f$:<operator>=<group_id>` are used. The `<operator>` is one of:

* `or` - Combine using logical _OR_.
* `and` - Combine using logical _AND_.
* `or!` - Combine using logical _OR_ and invert the result using logical _NOT_.
* `and!` - Combine using logical _AND_ and invert the result using logical _NOT_.

The `<group_id>` is the identifier used instead of the leading `f` in the tests that are included in the specified logical junction. For example:

* `f$dob!&f$city=Brooklyn&f$:or=g&g$status=ACTIVE&g$status:pre=NEW_` - Select records that do not have `dob` property value, have `city` property value equal "Brooklyn" and `status` property either equal "ACTIVE" or start with "NEW_".

If the property in the test is a collection (an array property), only empty/not empty test can be used. The parameter can have a value, like in a logical junction operator, that identifies the group of tests to apply to the collection elements. For example:

* `f$appointmentAvailabilities=g&g$weekday:alt=MON|TUE` - Select all records that have elements in the `appointmentAvailabilities` nested objects array property that have their `weekday` property either "MON" or "TUE".

#### Included Record Properties

By default, all record properties are returned in the search result and no referred records are fetched. To select only specific properties and/or include some referred records in the same search result, `p` URL query string parameter can be specified. The parameter's value is a comma-separated list of property path patterns. Each pattern can be:

* An asterisk ("*") to include all record properties that are included by default. Not specifying the `p` parameter is equivalent of `p=*`.
* A record property path in dot notation. If points to a nested property, all parent properties are included as well. If any of the intermediate properties is a reference property, the referred record is fetched as well and returned in the result. If the property is a nested object, all nested object properties that are included by default are included.
* A reference property path ending with ".*" to include the reference property and the referred record with all its properties that are included by default.
* A property path prefixed with a dash "-" to exclude the property that would be included otherwise (because of a wildcard pattern, for example).
* A super-property name prefixed with a dot (for example ".count" to include the total count of matched records in the result).

The above simply follows the fetch DBO query specification's `props` element.

So, for example, when searching _Order_ records:

* `p=status,accountRef.firstName,accountRef.lastName,items.productRef.*,-items.productRef.price,.count` - Include _Order_ record properties `status`, `accountRef` and `items`. In the `items` only include the `productRef`. Fetch _Account_ records referred by `accountRef` property and include only `firstName` and `lastName` properties. Fetch _Product_ records referred by `productRef` property in the `items` with all the _Product_ record properties except `price`. Also include total count of matched _Order_ records.

Note that the record id is always included whether explicitely requested or not.

#### Records Order

URL query string parameter `o` is used to specify partuclar order for the returned records. The value is a comma-separated list of property paths to order by. Any property path can be appended with `:desc` to make the descending order (or `:asc`, which is the default if nothing is specified). The property path may include value transformation functions the same way it is done in filter specification. For example:

* `o=status,price:desc,name:len:desc` - Order by status (ascending order), then by price in descending order, then by the length of the `name` property value in descending order.

#### Records Range

URL query string parameter `r` is used to return only a sub-range of the matched records. Its value is two numbers separated with a comma&mdash;first one is the first record to return (zero-based) and the second one is the maximum number of records to return. For example:

* `r=0,20` - Return only first 20 matched records.
* `r=100,20` - Return up to 20 records starting with the record 100.

Note, that the `.count` property (as well as any other super-aggregate property) mentioned in [Included Record Properties](#markdown-header-included-record-properties) is not affected by the range and always return the total number of matched records.

#### The Result Object

The JSON object returned in response to a search operation has the following properties:

* `recordTypeName` - Name of the record type searched (e.g. "Order", "Account", etc.).
* `records` - An array of objects representing the matched records. If no records matched, the array is empty.
* `referredRecords` - If any referred records were requested to be fetched, this property is included in the result. It's an object with keys being the references and values being objects representing the corresponding referred records.
* `count` and other super-aggregates - If `.count` (or any other super-aggregates) was requested, this is the total number of matched records.

For example:

```json
{
  "recordTypeName": "Order",
  "count": 2,
  "records": [
    {
      "id": 1,
      "status": "PENDING",
      "accountRef": "Account#2",
      "items": [
        {
          "id": 1,
          "productRef": "Product#10",
          "quantity": 1
        }
      ]
    },
    {
      "id": 2,
      "status": "SHIPPED",
      "accountRef": "Account#3",
      "items": [
        {
          "id": 2,
          "productRef": "Product#10",
          "quantity": 5
        }
      ]
    }
  ],
  "referredRecords": {
    "Product#10": {
      "id": 10,
      "name": "Sword",
      "price": 29.99
    },
    "Account#2": {
      "id": 2,
      "firstName": "Billy",
      "lastName": "Bones"
    },
    "Account#3": {
      "id": 3,
      "firstName": "John",
      "lastName": "Silver"
    },
  }
}
```

### Record Read

The record read operation is performed by sending an HTTP `GET` request to the individual record endpoint. It is used to get a specific record identified by its id. The record id is always the last URI parameter in the endpoint URI. The record is returned in the body of the HTTP 200 (OK) response. If record does not exist, an HTTP 404 (Not Found) is returned.

The URL can take a `p` query string parameter, the same way as with the search operation, if only specific record properties are needed. Note that requesting referred records and super-aggregates is not supported (they can be requested in the `p` parameter, but will not be returned).

### Record Creation

The record creation operation is performed by sending an HTTP `POST` request to the records collection endpoint. The record template is provided in the request body in JSON format (or any format, for which the application registers a marshaller). For example:

```http
POST /accounts/1/orders HTTP/1.1
Host: api.example.com
Accept: */*
Content-Type: application/json
Authorization: Bearer xxxxxxxxxxxxxxxxx
Content-Length: 263

{
  "accountRef": "Account#1",
  "status": "PENDING",
  "items": [
    {
      "productRef": "Product#10",
      "quantity": 5
    },
    {
      "productRef": "Product#15",
      "quantity": 1
    }
  ]
}
```

The successful response depends on the `post.response` handler option, which is described in the [Usage](#usage) section. By default, if the record was successfully created, an HTTP 201 (Created) response is returned with the record in the response body. The record will include some fields that were not present in the record template but were automatically generated by the backend, such as the new record id. It will also include such response headers as "Location", "Content-Location", "ETag" and "Last-Modified" (if record version properties are enabled).

If the record data is invalid, an HTTP 400 (Bad Request) is returned with a JSON object describing the error in the response body. The error description object has the following properties:

* `errorCode` - Error code that identifies the type of the error.
* `errorMessage` - General error description.
* `validationErrors` - An object with specific error messages for the parts of the record that are invalid. The keys are JSON pointers (see [RFC 6901](https://tools.ietf.org/html/rfc6901)) for invalid record elements (empty string for the record as a whole), the values are arrays of strings that are error descrpitions for the invalid fields.

When the handler calls the validators on the provided record template, it uses `onCreate` validators set.

### Record Update

The record update operation is performed by sending an HTTP `PATCH` request (see [RFC 5789](https://tools.ietf.org/html/rfc5789)) to the individual record endpoint. The body can be specified in either _JSON Patch_ format (see [RFC 6902](https://tools.ietf.org/html/rfc6902)) or _JSON Merge Patch_ format (see [RFC 7396](https://tools.ietf.org/html/rfc7396)).

The successful response depends on the `patch.response` handler option, which is described in the [Usage](#usage) section. By default, an HTTP 200 (OK) response is returned with the updated record data in the response body.

If data validation errors occur, an HTTP 422 (Unprocessable Entity) response is returned with the validation errors in the response body the same way as for the [Record Creation](#markdown-header-record-creation) operation. Invalid patch document will result in an HTTP 400 (Bad Request) response and if no record exists at the endpoint URI an HTTP 404 (Not Found) response will be returned.

When the handler calls the validators on the updated record, it uses `onUpdate` validators set.

### Record Delete

The record delete operation is performed by sending an HTTP `DELETE` request to the individual record endpoint. If successful, an HTTP 204 (No Content) response is returned. If the record does not exist at the endpoint URI, an HTTP 404 (Not Found) is returned.

## Handler Extensions

Both handler factory handler creation methods `collectionResource()` and `individualResource()` can take an optional second argument, which is an object that provides an extension to the basic handler implementation. The extension is a bunch of functions that act as "hooks" plugged into specific points in the handler's logic. There are two kinds of hooks:

* General handler configuration hooks that are common for all types of handlers and HTTP methods.

* Transaction hooks, which are functions plugged into certain points in the handler's basic transaction processing logic. These hooks are different for different handler types and HTTP methods.

### General Handler Configuration Hooks

These include two hooks:

* `configure()` - The function is called when the factory creates a new handler instance. It allows the handler to configure and initialize itself. The handler options are available as `this._options`.

* `isAllowed(call)` - Responds if the call is allowed to proceed from the authorization point of view. See [x2node-ws](https://www.npmjs.com/package/x2node-ws) module documentation for details.

* `isAllowedAction(action, actor, call)` - If the handler extension does not define `isAcllowed()` method, then it can define this `isAllowedAction()` method, which is the same as `isAllowed()`, but it receives an `action` argument, which allows the method to analyze the call from the resource action point of view rather than the HTTP method. The `action` argument can be "search", "create" (for collection resource handlers), "read", "update" or "delete" (for individual resource handlers). The method also receives `actor` extracted from the `call`, just for the implementation's convenience.

In general, the functions and properties defined on the extension are simply copied to the handler instance when it is created by the factory. The extension, therefore, can also completely redefine handler methods by providing its own implementations of `GET()`, `POST()`, etc.

One particular use-case for the `configure()` function is disabling certain methods on the handler. For example, if the _Account_ records may not be ever deleted via the web-service's API, one would want to disable the HTTP `DELETE` method on the individual record handler:

```javascript
ws.createApplication()
    ...
    .addEndpoint(
        '/accounts/([1-9][0-9]*)',
        handlers.individualResource('Account', {
            configure() {
                this.DELETE = false;
            }
        })
    )
    ...
```

The above removes the `DELETE()` method and replaces it with a Boolean `false` property on the handler thus telling the framework that the handler does not support HTTP `DELETE` method.

### Handler Transaction Hooks

The default implementations of the handler methods follow a certain pattern when processing a call. In general, the structure is:

1. Process the call, do the inital call validations, prepare everything for the transaction, build the DBO (some methods build the DBO after the transaction is started).

2. Initiate database transaction and execute the DBO.

3. Complete the transaction, form the response and return it.

Within that structure, the method implementations check if the extention has corresponding hook functions and call them if so. In general, the hooks can be plugged in at the following points:

* Before the transaction is started, before the main DBO is created. Allows additional call validation and give the extension a chance to influence the DBO construction. The names of these hooks start with `prepare`. Some methods may have more than one `prepare` hook.

* Just after the transaction is started but before the main DBO is executed. Gives the extension a chance to make call validations that require access to the database as well as place necessary transactional locks. The names of these hooks start with `before`. For some methods, the `before` hook is called before the main DBO is even constructed giving the handler another chance to influence the operation.

* Just after the main DBO is executed, but before the transaction is committed. Gives the extension a chance to perform additional operations that are part of a successful transaction. The names of these hooks start with `after`.

* After the transaction is committed or rolled back but before the response is built and returned. Gives the extension a chance to influence the response and/or perform other operations outside the database transaction. The names of these hooks start with `complete`. Note that these hooks are called regardless whether the transaction was successful or not.

Every hook function can return a `Promise`. If the promise is fulfilled, the operation continues and for the `before` and `after` hooks the transaction is allowed to commit. If the promise is rejected, the operation is aborted, for the `before` and `after` hooks the transaction is rolled back and the rejection object is returned as the handler result. If the returned value is not a `Promise`, it is treated as a result of a fulfilled promise.

#### Transaction Context

All transaction hook functions receive an object that represents the _transaction context_. This object provides the API that the framework exposes to the handler extensions. It also can be used by the hook functions to communicate between each other by setting implementation-specific properties on the transaction context object.

Each handler method receives its own specific variation of the transaction context object, but all of the transaction context objects expose the following common methods and properties:

* `call` - This is the `ServiceCall` object supplied by the [x2node-ws](https://www.npmjs.com/package/x2node-ws) module.

* `transaction` - This is the transaction supplied by the DBOs module. Available only to the hook functions that are called within a transaction.

* `dboFactory` - The DBO factory.

* `recordTypes` - The record types library.

* `log(message)` - Calls the debug logger associated with the resource handler, but adds information to the message that links it to the current context (including the call id and, if active, the transaction id). Same way as the underlying debug logger function, the method provides a read-only Boolean `enabled` property that tells if the debug logger is enabled or if it is a noop.

* `makeComplete()` - If called by a hook function, the rest of the handler method processing logic is cancelled, the transaction, if any, is committed, and the handler returns whatever the hook function returns.

* `refToId(recordTypeName, ref)` - Converts record reference (e.g. "Account#17") to record id (e.g. `17`). The first argument is the expected record type name and the second argument is the reference. If the reference is invalid or if it does not match the expected record type, an `X2SyntaxError` is thrown (see [x2node-common](https://www.npmjs.com/package/x2node-common) module). If the reference is `null` or `undefined`, it is returned without converting it to the id.

* `fetch(recordTypeName, querySpec)` - A shortcut method for building and executing a fetch DBO.

* `insert(recordTypeName, records, [passThrough])` - A shortcut method for building and executing insert DBOs. As opposed to the basic DBO factory methods, allows creating and executing multiple insert DBOs, so the `records` argument can be either a single record template or an array of record templates. Also supports an optional `passThrough` argument. If provided, the promise returned by the method, if the operation is successful, is fulfilled with it instead of the DBO result object. If not provided, the promise is fulfilled with the new record id, if the `records` argument is a single object, or an array of new record ids if the `records` argument is an array. Note, that the method does not perform any provided records validation/normalization.

* `update(recordTypeName, patchSpec, filterSpec, [passThrough])` - A shortcut method for building and executing an update DBO. As with the `insert()` method, an optional `passThrough` argument is supported. Note, that the method does not perform any patched record validation/normalization.

* `dynamicUpdate(recordTypeName, patchSpecProvider, filterSpec, [orderSpec], [passThrough])` - A shortcut method for building and executing a fetch DBO followed by a dynamically constructed series of update DBOs for each fetch record. The `filterSpec` and `orderSpec` arguments are used to fetch and lock records for update. The `patchSpecProvider` argument is a function that takes a single matched record as its only argument and returns a patch specification in JSON Patch format (that is an array of patch operation objects). The records are processed in the order they were fetched by the initial fetch DBO.

* `delete(recordTypeName, filterSpec, [passThrough])` - A shortcut for building and executing a delete DBO.

* `rejectIfExists(recordTypeName, filterSpec, httpStatusCode, errorMessage)` - A shortcut for checking if records of a given type matching the specified filter exist and if so, rejecting the returned promise with an error `ServiceResponse`. If matching records do not exist, the returned promise is fulfilled (with nothing).

* `rejectIfNotExists(recordTypeName, filterSpec, httpStatusCode, errorMessage)` - A shortcut for checking if records of a given type matching the specified filter do not exist and if so, rejecting the returned promise with an error `ServiceResponse`. If matching records do exist, they are locked in shared mode for the transaction and the returned promise is fulfilled (with nothing).

* `rejectIfNotExactNum(recordTypeName, filterSpec, expectedNum, httpStatusCode, errorMessage)` - A shortcut for checking if exact expected number of records of a given record type matching the specified filter exist and if it doesn't, return a promise that gets rejected with an error `ServiceResponse`. If the exact number of matching records exist, the returned promise is fulfilled (with nothing). The method also locks the matched records in shared mode for the transaction.

#### Record Search Hooks

These hooks are supported by the records collection resource handler implementation. In addition to the common methods and properties, the transaction context includes:

* `querySpec` - The query specification object for the fetch DBO.
* `queryParams` - Object with filter parameters for the fetch DBO.

The hooks are:

* `prepareSearch(txCtx)` - Called before the transaction is started and before the fetch DBO used for the search is constructed. By the time the hook is called, the `querySpec` and `queryParams` properties on the transaction context are constructed using the default handler logic. The hook can modify these objects and thus influence the resulting fetch DBO.

* `beforeSearch(txCtx)` - Called after transaction is started but before the DBO is executed. The DBO is already constrcuted by this point and cannot be changed.

* `afterSearch(txCtx, result)` - Called after the DBO is executed but before the transaction is committed. The `result` argument is the fetch DBO result object. The function must return a result object (or a promise of it) that will be used for the response. In the simplest case it simply returns the `result` argument passed into it.

* `completeSearch(err, txCtx, result)` - Called after the transaction is finished but before the response is built. If there was an error and the transaction was rolled back, the `err` argument is provided and the `result` argument is not. If the transaction was successful, the `err` is `undefined` and the `result` object is the search result. The function must return a result object (or a promise of it) for the response. Alternatively it may return a `ServiceResponse` object, in which case it is used instead of the handler's default response building logic. If it returns a promise that gets rejected, a corresponding error response is returned.

#### Record Read Hooks

These hooks are supported by the individual record resource handler implementation. In addition to the common methods and properties, the transaction context includes:

* `querySpec` - The query specification object for the fetch DBO.
* `queryParams` - Object with filter parameters for the fetch DBO.
* `referredRecords` - If any referred records were fetched as a result of executing the fetch DBO (usually that happens if the handler adds referred records to the `querySpec` in the `prepareRead` hook), then they are stored in this context property.

The hooks are:

* `prepareRead(txCtx)` - Called before the transaction is started and before the fetch DBO used to read the record is created. By the time the hook is called, the `querySpec` and `queryParams` properties on the transaction context are constructed using the default handler logic. The hook can modify these objects and thus influence the resulting fetch DBO.

* `beforeRead(txCtx)` - Called after transaction is started but before the DBO is executed. The DBO is already constructed by this point and cannot be changed.

* `afterRead(txCtx, record)` - Called after the DBO is executed but before the transaction is committed. The `record` argument is the fetched record (this hook is not called if the record was not found because the handler generates an error). The function must return a record object (or a promise of it) that will be used for the response. In the simplest case it simply returns the `record` argument passed into it.

* `completeRead(err, txCtx, record)` - Called after the transaction is finished but before the response is built. If there was an error and the transaction was rolled back, the `err` argument is provided and the `record` argument is not. If the transaction was successful, the `err` is `undefined` and the `record` object is the fetched record. The function must return a record object (or a promise of it) for the response. Alternatively it may return a `ServiceResponse` object, in which case it is used instead of the handler's default response building logic. If it returns a promise that gets rejected, a corresponding error response is returned.

#### Record Creation Hooks

These hooks are supported by the records collection resource handler implementation. In addition to the common methods and properties, the transaction context includes:

* `recordTmpl` - The record template submitted with the call.
* `parentQuerySpec` - If dependent record (the endpoint URI includes parent record id), this is the query specification for a fetch DBO used by the handler to fetch the parent record and that way verify that the parent record exists. The default query specification only fetches the parent record id property and also locks the parent record (and all of its parents) in shared mode.
* `parentQueryParams` - Parameters for the `parentQuerySpec`.
* `parentRecord` - Parent record fetched by the DBO constructed using `parentQuerySpec`.

The hooks are:

* `prepareCreateSpec(txCtx, recordTmpl)` - Called before the transaction is started, before the insert DBO is created and before the record template is validated, which gives the hook a chance to make changes to the record template. The `recordTmpl` argument is the same as the `recordTmpl` object on the transaction context provided as an argument for convenience.

* `prepareCreate(txCtx, recordTmpl)` - Like `prepareCreateSpec`, but called _after_ the record template is validated. Also, if dependent record endpoint, the default `parentQuerySpec` and `parentQueryParams` are made available on the transaction context. The hook can still modify them to influence the DBO used to fetch the parent record.

* `beforeCreate(txCtx, recordTmpl)` - Called after the transaction is started, but before the insert DBO is created and executed. At this point the hook can still make changes to the record template that will influence the insert DBO. Also, if dependent record endpoint, by this point the `parentRecord` is made available on the transaction context.

* `afterCreate(txCtx, record)` - Called after the DBO is executed but before the transaction is committed. The `record` argument is the new record. The function must return a record object (or a promise of it) that will be used for the response. In the simplest case it simply returns the `record` argument passed into it.

* `completeCreate(err, txCtx, record)` - Called after the transaction is finished but before the response is built. If there was an error and the transaction was rolled back, the `err` argument is provided and the `record` argument is not. If the transaction was successful, the `err` is `undefined` and the `record` object is the new record. The function must return a record object (or a promise of it) for the response. Alternatively it may return a `ServiceResponse` object, in which case it is used instead of the handler's default response building logic. If it returns a promise that gets rejected, a corresponding error response is returned.

#### Record Update Hooks

These hooks are supported by the individual record resource handler implementation. In addition to the common methods and properties, the transaction context includes:

* `patchSpec` - The patch specification document from the call. This document is used to build the `patch` object (see next property).
* `patch` - The parsed `RecordPatch` object (see [x2node-patches](https://www.npmjs.com/package/x2node-patches) module) submitted with the request.
* `selectionFilter` - Filter specification used to select the record to update.
* `queryParams` - Parameters for the record selection filter.
* `updateResult` - Update DBO result object.

The hooks are:

* `prepareUpdateSpec(txCtx, patchSpec)` - Called before the transaction is started, the update DBO is created and before the patch is constructed, which gives the hook a chance to make changes to the patch specification document or build its own `RecordPatch` alltogether and set it to the `patch` property on the context.

* `prepareUpdate(txCtx)` - Called before the transaction is started and before the update DBO is created but after the patch has been constructed. The transaction context will have the `patch` and the `selectionFilter` and `queryParams` objects built according to the handler's default logic. The hook can modify these properties on the transaction context to influence the resulting DBOs.

* `beforeUpdate(txCtx, record)` - Called after transaction is started and the record to be updated is loaded from the database, but before the patch is applied. The `record` argument is the record loaded from the database with all the properties fetched by default. This is the record, to which the requested patch is applied.

* `beforeUpdateSave(txCtx, record)` - Called after the requesed patch is applied to the record and the resulting patched record is validated and normalized, but before it is saved back into the database. The `record` argument is the patched record. The hook can still make final changes to the record before it is saved. Note, however, that no record validation/normalization is performed after this point.

* `afterUpdate(txCtx, record)` - Called after the DBO is executed but before the transaction is committed. The `record` argument is the updated record. The function must return a record object (or a promise of it) that will be used in the response. In the simplest case it can simply return the `record` argument as it was passed to it. The `updateResult` object is available on the transaction context at this point.

* `completeUpdate(err, txCtx, record)` - Called after the transaction is finished but before the response is built. If there was an error and the transaction was rolled back, the `err` argument is provided and the `record` argument is not. If the transaction was successful, the `err` is `undefined` and the `record` object is the updated record. The function must return a record object (or a promise of it) for the response. Alternatively it may return a `ServiceResponse` object, in which case it is used instead of the handler's default response building logic. If it returns a promise that gets rejected, a corresponding error response is returned.

#### Record Delete Hooks

These hooks are supported by the individual record resource handler implementation. In addition to the common methods and properties, the transaction context includes:

* `selectionFilter` - Filter specification used to select the record to delete.
* `queryParams` - Parameters for the record selection filter.
* `fetchProps` - Optional array of record properties to fetch before deleting the record.
* `record` - Fetched record.
* `referredRecords` - Fetched referred records.
* `deleteResult` - Delete DBO result object.

The hooks are:

* `prepareDelete(txCtx)` - Called before the transaction is started and before the delete DBO is created. The transaction context will have the `selectionFilter` and `queryParams` objects built according to the handler's default logic. The hook can modify these properties on the transaction context to influence the resulting delete DBO. In addition to that, the hook can set `fetchProps` on the transaction context. If it does so, the record will be fetched and locked in exclusive mode before it is deleted and made available to the rest of the handler logic. The properties fetched are determined by the patterns provided in the `fetchProps` array. The fetched record is passed to the hooks as an argument and also made available on the context as `record`. If any referred records are requested to be fetched as well, they are made available on the context as `referredRecords`.

* `beforeDelete(txCtx, [record])` - Called after transaction is started but before the DBO is executed.

* `afterDelete(txCtx, [record])` - Called after the DBO is executed but before the transaction is committed. The `deleteResult` object is available on the transaction context.

* `completeDelete(err, txCtx, [record])` - Called after the transaction is finished but before the response is built. If there was an error and the transaction was rolled back, the `err` argument is provided. If the transaction was successful, the `err` is `undefined`. The function may return a `ServiceResponse` object, in which case it is used instead of the handler's default response building logic. If it returns a promise that gets rejected, a corresponding error response is returned.

## Miscellaneous

The module provides some miscellaneous helpers described below.

### Auto-Assigned Properties

Backend applications often automatically assign some record properties by either generating the values or by retrieving the values from third-party systems. For these properties, when a new record is created via a `POST` the value in the template must/can be empty. Once the record is created, the property is often unmodifiable. The module provides an object that can be used as the property validators definition. For example:

```javascript
const recordTypes = records.with(dbos).buildLibrary({
    recordTypes: {
        'Account': {
            table: 'accounts',
            properties: {
                'id': {
                    valueType: 'number',
                    role: 'id'
                },
                'token': {
                    valueType: 'string',
                    modifiable: false,
                    validators: resources.AUTOASSIGNED
                },
                ...
            }
        },
        ...
    }
});
```

The above is equivalent to:

```javascript
...
'token': {
    valueType: 'string',
    modifiable: false,
    validators: {
        'onCreate': [ 'empty' ],
        'onUpdate': [ 'required' ],
        '*': [ '-required' ]
    }
},
...
```

The property `token` is required, but we remove the `required` validator from the default validation set to allow `empty` validator for the `onCreate` set. We add the `required` back spefifically for the `onUpdate` validation set. The latter is technically unnecessary in our specific case, because the property is not modifiable anyway. However, having it allows us to control whether the property is modifiable or not using only the `modifiable` definition attribute.

Another predefined validators object is `resources.OPTIONALLY_AUTOASSIGNED`, which is the same as `resources.AUTOASSIGNED`, but allows a value to be provided when a new record is created. In the example above, if we want to allow the client to generate the `token` itself instead of having the backend application generate it, we could say:

```javascript
...
'token': {
    valueType: 'string',
    modifiable: false,
    validators: resources.OPTIONALLY_AUTOASSIGNED
},
...
```

which is equivalent to:

```javascript
...
'token': {
    valueType: 'string',
    modifiable: false,
    validators: {
        'onUpdate': [ 'required' ],
        '*': [ '-required' ]
    }
},
...
```
