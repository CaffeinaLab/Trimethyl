/**
 * @module  http
 * @author  Flavio De Stefano <flavio.destefano@caffeina.com>
 */

var Util = require('T/util');

/**
 * @property config
 * @property {String}  config.base 							The base URL of the API
 * @property {Number}  [config.timeout=30000] 				Global timeout for the reques. after this value (express in milliseconds) the requests throw an error.
 * @property {Object}  [config.headers={}] 					Global headers for all requests.
 * @property {Boolean} [config.log=false] 					Log the requests.
 * @property {Boolean} [config.cache=true] 					Check if the response should be cached.
 * @property {Boolean} [config.bodyEncodingInJSON=false] 	Force to encoding in JSON of body data is the input is a JS object.
 * @property {Boolean} [config.sslPinning=false] 			If this value is an array, it must contain the domains on which to apply SSL pinning. If this value is true, SSL pinning is applied on base HTTP domain. Certificates must be located in /app/assets/certs and named as the the domain name without extension. (example: "/app/assets/certs/youtube.com")
 * @property {String} [config.certificatesPath] 			The path of the certificates directory
 */
exports.config = _.extend({
	base: '',
	timeout: 30000,
	headers: {},
	log: false,
	cache: true,
	bodyEncodingInJSON: false,
	sslPinning: false,
	certificatesPath: Util.getResourcesDirectory() + "certs/",
}, Alloy.CFG.T ? Alloy.CFG.T.http : {});

var MODULE_NAME = 'http';

var Event = require('T/event');
var Q = require('T/ext/q');
var PermissionsStorage = require('T/permissions/storage');

var securityManager = null;

function extractHTTPText(data, info) {
	if (info != null && data != null) {
		if (info.format === 'json') {
			return Util.parseJSON(data);
		}
	}
	return data;
}

function HTTPRequest(opt) {
	var self = this;
	if (opt.url == null) {
		throw new Error(MODULE_NAME + '.Request: URL not set');
	}

	this.opt = opt;

	// if the url is not matching a protocol, assign the base URL
	if (/\:\/\//.test(opt.url)) {
		this.url = opt.url;
	} else {
		this.url = exports.config.base.replace(/\/$/, '') + '/' + opt.url.replace(/^\//, '');
	}

	this.domain = Util.getDomainFromURL(this.url);
	this.method = opt.method != null ? opt.method.toUpperCase() : 'GET';

	// Construct headers: global + per-domain + local
	this.headers = _.extend({}, exports.getHeaders(), exports.getHeaders(this.domain), opt.headers);
	this.timeout = opt.timeout != null ? opt.timeout : exports.config.timeout;
	this.cache = opt.cache != null ? opt.cache : exports.config.cache;

	this.configureSSLPinning();
	this.securityManager = opt.securityManager || securityManager;

	// Rebuild the URL if is a GET and there's data
	if (opt.data != null) {
		if (this.method === 'GET') {
			if (typeof opt.data === 'object') {
				var exQuery = /\?.*/.test(this.url);
				this.url = this.url + Util.buildQuery(opt.data, exQuery ? '&' : '?');
			}
		} else {
			if (exports.config.bodyEncodingInJSON == true || opt.bodyEncodingInJSON == true) {
				this.headers['Content-Type'] = 'application/json';
				this.data = JSON.stringify(opt.data);
			} else {
				this.data = opt.data;
			}
		}
	}

	this.hash = this._calculateHash();
	this.uniqueId = exports.getUniqueId();

	// Fill the defer, we will manage the callbacks through it
	this.defer = Q.defer();
	this.defer.promise.then(function() { self._onSuccess.apply(self, arguments); });
	this.defer.promise.catch(function() { self._onError.apply(self, arguments); });
	this.defer.promise.finally(function() { self._onFinally.apply(self, arguments); });

	Ti.API.debug(MODULE_NAME + ': <' + this.uniqueId + '>', this.method, this.url, this.data);
}

HTTPRequest.prototype.configureSSLPinning = function() {
	if (securityManager != null) return;

	if (exports.config.sslPinning == false) return;

	var AppcHttps = Util.requireOrNull('appcelerator.https');
	if (AppcHttps == null) {
		return Ti.API.error(MODULE_NAME + ': SSL pinning requires appcelerator.https module');
	}

	// If sslPinning is an array, create a cert pinning entry for each entry
	if (_.isArray(exports.config.sslPinning)) {
		securityManager = AppcHttps.createX509CertificatePinningSecurityManager(_.map(exports.config.sslPinning, function(domain) {
			var path = exports.config.certificatesPath + domain;
			if (Ti.Filesystem.getFile(path).exists() == false) {
				throw new Error(MODULE_NAME + ': certificate for SSL pinning not found (' + domain + ')');
			}
			return {
				url: "https://" + domain,
				serverCertificate: path
			};
		}));

	// otherwise, if true, configure just for the base domain in HTTP.config
	} else if (exports.config.sslPinning == true) {
		var domain = Util.getDomainFromURL(config.base);
		var path = exports.config.certificatesPath + domain;
		if (Ti.Filesystem.getFile(path).exists() == false) {
			throw new Error(MODULE_NAME + ': certificate for base SSL pinning not found (' + domain + ')');
		}
		securityManager = AppcHttps.createX509CertificatePinningSecurityManager([{
			url: "https://" + Util.getDomainFromURL(config.base),
			serverCertificate: path
		}]);
	}
};

HTTPRequest.prototype.toString = function() {
	return this.hash;
};

HTTPRequest.prototype._getResponseInfo = function() {
	if (this.client == null || this.client.readyState < 1) {
		throw new Error(MODULE_NAME + ': Client is null or not ready');
	}

	var headers = {};
	try {
		headers.ContentType = this.client.getResponseHeader('Content-Type');
	} catch(err) {
		Ti.API.warn(MODULE_NAME + ': Error while getting Content-Type header: ' + err);
	}

	var info = {
		format: 'blob',
	};

	if (this.client.responseText != null) {
		info.format = 'text';
		if (/^application\/json/.test(headers.ContentType)) info.format = 'json';
	}

	// Override
	if (this.opt.format != null) info.format = this.opt.format;

	return info;
};

HTTPRequest.prototype._onSuccess = function() {
	if (this.endTime != null) {
		Ti.API.trace(MODULE_NAME + ':  <' + this.uniqueId + '> response success (in ' + (this.endTime - this.startTime) + 'ms)');
	} else {
		Ti.API.trace(MODULE_NAME + ':  <' + this.uniqueId + '> response success');
	}

	if (exports.config.log === true) {
		// Log response from server
		Ti.API.trace(MODULE_NAME + ':  <' + this.uniqueId + '>', arguments[0]);
	}

	if (OS_ANDROID && this.client != null) {
		if ((this.client.status >= 300 && this.client.status < 400) && this.client.location != this.url) {
			Ti.API.trace(MODULE_NAME + ':  <' + this.uniqueId + '> following redirect to ' + this.client.location);

			exports.send(_.extend(this.opt, { url: this.client.location }));
			return;
		}
	}

	if (_.isFunction(this.opt.success)) {
		this.opt.success.apply(this, arguments);
	}
};

HTTPRequest.prototype._onError = function(err) {
	Ti.API.error(MODULE_NAME + ':  <' + this.uniqueId + '>', err);

	if (_.isFunction(this.opt.error)) {
		this.opt.error.apply(this, arguments);
	}
};


HTTPRequest.prototype._onFinally = function() {
	if (_.isFunction(this.opt.complete)) {
		this.opt.complete.apply(this, arguments);
	}
};

HTTPRequest.prototype._whenComplete = function(e) {
	var self = this;
	this.endTime = Date.now();
	exports.removeFromQueue(this);

	// Fire the global event
	if (this.opt.silent !== true) {
		Event.trigger(MODULE_NAME + '.end', {
			hash: this.hash,
			eventName: this.opt.eventName
		});
	}

	try {
		this.responseInfo = this._getResponseInfo();
	} catch (ex) {
		this.defer.reject({
			code: 0,
			broken: true
		});
		return;
	}

	var data = null;
	if (this.opt.format === 'blob') {
		data = this.client.responseData;
	} else {
		data = extractHTTPText(this.client.responseText, this.responseInfo);
	}

	var returnData = data;
	if (e.success) {
		this.defer.resolve(returnData);
	} else {
		returnData = {
			message: (this.opt.format === 'blob') ? null : Util.getErrorMessage(data),
			error: e.error,
			code: this.client.status,
			response: data
		};

		this.defer.reject(returnData);
	}

	_.each(hooks, function(hook, name) {
		if (self.opt.suppressHooks == true) return;
		if (_.isArray(self.opt.suppressHooks) && self.opt.suppressHooks.indexOf(name) >= 0) return;

		hook(returnData);
	});
};

HTTPRequest.prototype._calculateHash = function() {
	var hash = this.url + Util.hashJavascriptObject(this.data) + Util.hashJavascriptObject(this.headers);
	return 'http_' + Ti.Utils.md5HexDigest(hash);
};

HTTPRequest.prototype.send = function() {
	var self = this;

	var promise = Q();
	_.each(filters, function(filter, name) {
		if (self.opt.suppressFilters == true) return;
		if (_.isArray(self.opt.suppressFilters) && self.opt.suppressFilters.indexOf(name) >= 0) return;

		promise = promise.then( filter.bind(null, self) );
	});

	promise
	.then(self._send.bind(self))
	.fail(function(ex) {
		Ti.API.error(MODULE_NAME + ':  <' + self.uniqueId + '> filter rejection', ex);
		self.defer.reject(ex);
	});
};

HTTPRequest.prototype._send = function() {
	var self = this;

	var client = Ti.Network.createHTTPClient(_.extend({
		timeout: this.timeout,
		cache: this.cache,
	},
	this.securityManager ? { securityManager: this.securityManager } : {}
	));

	client.onload = client.onerror = function(e) { self._whenComplete(e); };

	// Add this request to the queue
	exports.addToQueue(this);

	if (this.opt.silent !== true) {
		Event.trigger(MODULE_NAME + '.start', {
			hash: this.hash,
			eventName: this.opt.eventName
		});
	}

	// Progress callbacks
	if (_.isFunction(this.opt.ondatastream)) client.ondatastream = this.opt.ondatastream;
	if (_.isFunction(this.opt.ondatasend)) client.ondatasend = this.opt.ondatasend;

	client.open(this.method, this.url);

	// Set file receiver
	if (this.opt.file != null) {
		client.file = this.opt.file;
	}

	// Set headers
	_.each(this.headers, function(h, k) {
		client.setRequestHeader(k, h);
	});

	// Send the request over Internet
	this.startTime = Date.now();
	if (this.data != null) {
		client.send(this.data);
	} else {
		client.send();
	}

	this.client = client;
};

HTTPRequest.prototype.resolve = function() {
	if (Ti.Network.online) {
		this.send();
	} else {
		Event.trigger(MODULE_NAME + '.offline');
		this.defer.reject({
			offline: true,
			code: 0,
			message: L('network_offline', 'Check your connectivity.')
		});
	}
};

HTTPRequest.prototype.abort = function() {
	if (this.client != null) {
		this.client.abort();
		Ti.API.debug(MODULE_NAME + ':  <' + this.uniqueId + '> aborted!');
	}
};

HTTPRequest.prototype.success = HTTPRequest.prototype.then = function(func) {
	this.opt.success = func;
	return this;
};

HTTPRequest.prototype.error = HTTPRequest.prototype.fail = HTTPRequest.prototype.catch = function(func) {
	this.opt.error = func;
	return this;
};

HTTPRequest.prototype.complete = HTTPRequest.prototype.fin = HTTPRequest.prototype.finally = function(func) {
	this.opt.complete = func;
	return this;
};

HTTPRequest.prototype.getPromise = function() {
	return this.defer.promise;
};


var filters = {};

/**
 * @param {String} 	name 	The name of the middleware
 * @param {Function} func  The function
 */
exports.addFilter = function(name, func) {
	filters[name] = func;
};

/**
 * @param {String} 	name 	The name of the middleware
 */
exports.removeFilter = function(name, func) {
	delete filters[name];
};


var hooks = {};

/**
 * Add a method to be called at each HTTP call completion
 * @param {String} 	name 	The name of the callback
 * @param {Function} func  The function. It will be invoked with the result of the HTTP call as parameter.
 */
exports.addHook = function(name, func) {
	hooks[name] = func;
};

/**
 * @param {String} 	name 	The name of the callback
 */
exports.removeHook = function(name, func) {
	delete hooks[name];
};

/**
 * Attach events to current module
 */
exports.event = function(name, cb) {
	Event.on(MODULE_NAME + '.' + name, cb);
};

/**
 * @return {String}
 */
var __uniqueId = 0;
exports.getUniqueId = function() {
	return __uniqueId++;
};

var headers = _.clone(exports.config.headers);
var headersPerDomain = {};

/**
 * @return {Object}
 */
exports.getHeaders = function(domain) {
	if (domain == null) {
		return headers;
	} else {
		return headersPerDomain[domain] || {};
	}
};

/**
 * Add a global header for all requests
 * @param {String} key 					The header key
 * @param {String} value 				The header value
 * @param {String} [domain=null]		Optional domain
 */
exports.addHeader = function(key, value, domain) {
	if (domain == null) {
		headers[key] = value;
	} else {
		headersPerDomain[domain] = headersPerDomain[domain] || {};
		headersPerDomain[domain][key] = value;
	}
};

/**
 * Remove a global header
 * @param {String} key 					The header key
 * @param {String} [domain=null] 	Optional domain
 */
exports.removeHeader = function(key, domain) {
	if (domain == null) {
		delete headers[key];
	} else {
		if (headersPerDomain[domain] != null) {
			delete headersPerDomain[domain][key];
		}
	}
};

/**
 * Reset all globals headers
 * @param {String} [domain=null]		Optional domain
 */
exports.resetHeaders = function(domain) {
	if (domain == null) {
		headers = {};
		headersPerDomain = {};
	} else {
		headersPerDomain[domain] = {};
	}
};


var queue = [];

/**
 * Check if the requests queue is empty
 * @return {Boolean}
 */
exports.isQueueEmpty = function(){
	return _.isEmpty(queue);
};

/**
 * Get the current requests queue
 * @return {Array}
 */
exports.getQueue = function(){
	return queue;
};

/**
 * Add a request to queue
 * @param {HTTP.Request} request
 */
exports.addToQueue = function(request) {
	queue[request.hash] = request;
};

/**
 * Remove a request from queue
 */
exports.removeFromQueue = function(request) {
	delete queue[request.hash];
};

/**
 * Reset the cookies for all requests
 */
exports.resetCookies = function() {
	Ti.Network.removeAllHTTPCookies();
};


/**
 * The main function of the module.
 *
 * Create an HTTP.Request and resolve it
 *
 * @param {Object} opt 							The request dictionary
 * @param {String} opt.url 					The endpoint URL
 * @param {String} [opt.method="GET"] 		The HTTP method to use (GET|POST|PUT|PATCH|..)
 * @param {Object} [opt.headers] 			An Object key-value of additional headers
 * @param {Number} [opt.timeout] 			Ovverride the timeout default value
 * @param {Boolean} [opt.cache] 				Override the cache default behav
 * @param {Function} [opt.success] 			The success callback
 * @param {Function} [opt.error] 			The error callback
 * @param {String} [opt.format] 				Override the format for that request (like `json`)
 * @param {(Boolean|Array)} [opt.suppressFilters]	Prevent calling some or all of the filters added previously
 * @param {(Boolean|Array)} [opt.suppressHooks]		Prevent calling some or all of the hooks added previously
 * @return {HTTP.Request}
 */
function send(opt) {
	var request = new HTTPRequest(opt);
	request.resolve();
	return request;
}
exports.send = send;


/**
 * Make a GET request to that URL
 * @param  {String}   	url The endpoint url
 * @param  {Function} 	success  Success callback
 * @param  {Function} 	error Error callback
 * @return {HTTP.Request}
 */
exports.get = function(url, success, error) {
	return send({
		url: url,
		method: 'GET',
		success: success,
		error: error
	});
};


/**
 * Make a POST request to that URL
 * @param  {String}   	url 		The endpoint url
 * @param  {Object}   	data 		The data
 * @param  {Function} 	success  Success callback
 * @param  {Function} 	error 	Error callback
 * @return {HTTP.Request}
 */
exports.post = function(url, data, success, error) {
	return send({
		url: url,
		method: 'POST',
		data: data,
		success: success,
		error: error
	});
};


/**
 * Make a GET request to that url with that data and setting the format forced to JSON
 * @param  {String}   	url 		The endpoint url
 * @param  {Object}   	data 		The data
 * @param  {Function} 	success  Success callback
 * @param  {Function} 	error 	Error callback
 * @return {HTTP.Request}
 */
exports.getJSON = function(url, data, success, error) {
	return send({
		url: url,
		data: data,
		method: 'GET',
		format: 'json',
		success: success,
		error: error
	});
};


/**
 * Make a POST request to that url with that data and setting the format forced to JSON
 * @param  {String}   	url 			The endpoint url
 * @param  {Object}   	data 			The data
 * @param  {Function} 	success  	Success callback
 * @param  {Function} 	error 		Error callback
 * @return {HTTP.Request}
 */
exports.postJSON = function(url, data, success, error) {
	return send({
		url: url,
		data: data,
		method: 'POST',
		format: 'json',
		success: success,
		error: error
	});
};


/**
 * @param  {String}  			url  				The url
 * @param  {Object}  			filename  		File name or `Ti.File`
 * @param  {Function}  			success  		Success callback
 * @param  {Function} 			error  			Error callback
 * @param  {Function}  			ondatastream  	Progress callback
 * @return {HTTP.Request}
 */
exports.download = function(url, file, success, error, ondatastream) {
	var doDownload = function() {
		var tiFile = null;
		if (file == null) {
			tiFile = Ti.Filesystem.getFile(Util.getAppDataDirectory(), Ti.Utils.md5HexDigest(url + Date.now()));
		} else if (_.isString(file)) {
			tiFile = Ti.Filesystem.getFile(Util.getAppDataDirectory(), file);
		} else {
			tiFile = file;
		}

		send({
			url: url,
			cache: false,
			format: 'blob',
			file: tiFile.resolve(),
			ondatastream: ondatastream,
			error: error,
			success: function() {
				if (tiFile.exists()) {
					success(tiFile);
				} else {
					error({
						message: L('unable_to_write_file', 'Unable to write file')
					});
				}
			}
		});
	};

	PermissionsStorage.request(doDownload, error);
};

/**
 * Export the HTTP cookies to the system to make them available to `WebViews`
 * @param  {String} domain The domain. Default is `HTTP.config.base`
 */
exports.exportCookiesToSystem = function(domain) {
	if (!OS_ANDROID) return;

	domain = domain || exports.config.base.replace('http://', '');
	_.each(Ti.Network.getHTTPCookiesForDomain(domain), function(c) {
		Ti.Network.addSystemCookie(c);
	});
};

//////////
// Init //
//////////

headers['X-Ti-Version']  = Ti.version;
headers['X-Platform'] = Util.getPlatformFullName();

headers['X-App-Id'] = Ti.App.id;
headers['X-App-Version'] = Ti.App.version;
headers['X-App-DeployType'] = Ti.App.deployType;

if (OS_IOS) {
	headers['X-App-InstallId'] = Ti.App.installId;
}
