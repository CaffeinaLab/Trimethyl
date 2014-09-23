/*
 * @author  Flavio De Stefano <flavio.destefano@caffeinalab.com>
 * API-Rest Alloy Adapter
 */

var HTTP = require('T/http');

var CRUD_to_REST = {
	'create' : 'POST',
	'read' : 'GET',
	'update' : 'PUT',
	'delete' : 'DELETE'
};

exports.sync = function(method, model, opt) {
	var isCollection;
	var url = (model.config.adapter.baseUrl || '/') + model.config.adapter.name;

	if (model.id) {
		isCollection = false;
		url += '/' + model.id;
	} else {
		isCollection = true;
	}

	if (opt.patch) method = 'patch';

	var data = _.extend({}, opt.http, {
		url: url,
		method: CRUD_to_REST[method],
		mime: 'json'
	});

	if (Alloy.Backbone.emulateHTTP) {
		if (['DELETE','PUT','PATCH'].indexOf(data.method)!==-1) {
			data.method = 'POST';
			data.headers = _.extend({}, data.headers, {
				'X-HTTP-Method-Override': data.method
			});
		}
	}

	switch (method) {

		case 'create':
		HTTP.send(_.extend({}, data, {
			data: model.toJSON(),
			success: function(resp) {

				if (resp != null && resp.id != null) {
					opt.success(resp);
				} else {
					opt.error();
				}

				model.trigger('fetch');
			},
			error: opt.error
		}));
		break;

		case 'read':
		HTTP.send(_.extend({}, data, {
			data: opt.args || {},
			success: function(resp) {

				if (resp != null) {
					if (isCollection === true) {
						if (_.isObject(resp) && resp.data != null) opt.success(resp.data);
						else if (_.isArray(resp)) opt.success(resp);
						else opt.error();
					} else {
						opt.success(resp);
					}
				} else {
					opt.error();
				}

				model.trigger('fetch');
			},
			error: opt.error
		}));
		break;

		case 'update':
		HTTP.send(_.extend({}, data, {
			data: _.pick(model.attributes, _.keys(opt.changes)),
			success: function(resp) {

				if (resp != null) {
					opt.success();
				} else {
					opt.error();
				}

				model.trigger('fetch');
			},
			error: opt.error
		}));
		break;

		case 'delete':
		HTTP.send(_.extend({}, data, {
			data: opt.args || {},
			success: function(resp) {

				if (resp != null) {
					opt.success();
				} else {
					opt.error();
				}

				model.trigger('fetch');
			},
			error: opt.error
		}));
		break;

	}
};