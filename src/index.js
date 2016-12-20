var async = require('async');
var mysql = require('mysql');
var _ = require('underscore');
var noop = function(){};
var logPrefix = '[nodebb-plugin-import-phpbb3.1]';

const Exporter = module.exports

const executeQuery = (query) => new Promise((resolve, reject) => {
	Exporter.connection.query(query, (err, rows) => {
		if(err) return reject(err)
		resolve(rows)
	});
})

Exporter.setup = (config) => {
	Exporter.log('setup');

	var _config = {
		host: config.dbhost || config.host || 'localhost',
		user: config.dbuser || config.user || 'root',
		password: config.dbpass || config.pass || config.password || '',
		port: config.dbport || config.port || 3306,
		database: config.dbname || config.name || config.database || 'phpbb'
	};

	Exporter.config(_config);
	Exporter.config('prefix', config.prefix || config.tablePrefix || '' /* phpbb_ ? */ );

	Exporter.connection = mysql.createConnection(_config);
	Exporter.connection.connect();

	return Exporter.config()
}

Exporter.getUsers = function() {
	return Exporter.getPaginatedUsers(0, -1);
};
Exporter.getPaginatedUsers = async (start, limit) => {
	Exporter.log('getPaginatedUsers')
	var err;
	var prefix = Exporter.config('prefix');
	var startms = +new Date();
	var query = 'SELECT '
		+ prefix + 'users.user_id as _uid, '
		+ prefix + 'users.username as _username, '
		+ prefix + 'users.username_clean as _alternativeUsername, '
		+ prefix + 'users.user_email as _registrationEmail, '
		//+ prefix + 'users.user_rank as _level, '
		+ prefix + 'users.user_regdate as _joindate, '
		+ prefix + 'users.user_email as _email '
		//+ prefix + 'banlist.ban_id as _banned '
		//+ prefix + 'USER_PROFILE.USER_SIGNATURE as _signature, '
		//+ prefix + 'USER_PROFILE.USER_HOMEPAGE as _website, '
		//+ prefix + 'USER_PROFILE.USER_OCCUPATION as _occupation, '
		//+ prefix + 'USER_PROFILE.USER_LOCATION as _location, '
		//+ prefix + 'USER_PROFILE.USER_AVATAR as _picture, '
		//+ prefix + 'USER_PROFILE.USER_TITLE as _title, '
		//+ prefix + 'USER_PROFILE.USER_RATING as _reputation, '
		//+ prefix + 'USER_PROFILE.USER_TOTAL_RATES as _profileviews, '
		//+ prefix + 'USER_PROFILE.USER_BIRTHDAY as _birthday '

		+ 'FROM ' + prefix + 'users '
		+ 'WHERE ' + prefix + 'users.user_id = ' + prefix + 'users.user_id '
		+ (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');


	if (!Exporter.connection) {
		err = {error: 'MySQL connection is not setup. Run setup(config) first'};
		Exporter.error(err.error);
		throw err
	}

	const rows = await executeQuery(query)

	//normalize here
	var map = {};
	rows.forEach(function(row) {
		// nbb forces signatures to be less than 150 chars
		// keeping it HTML see https://github.com/akhoury/nodebb-plugin-import#markdown-note
		row._signature = Exporter.truncateStr(row._signature || '', 150);

		// from unix timestamp (s) to JS timestamp (ms)
		row._joindate = ((row._joindate || 0) * 1000) || startms;

		// lower case the email for consistency
		row._email = (row._email || '').toLowerCase();

		// I don't know about you about I noticed a lot my users have incomplete urls, urls like: http://
		row._picture = Exporter.validateUrl(row._picture);
		row._website = Exporter.validateUrl(row._website);

		map[row._uid] = row;
	});

	return map
};

Exporter.getCategories = () => Exporter.getPaginatedCategories(0, -1)

Exporter.getPaginatedCategories = async (start, limit) => {
	Exporter.log('getPaginatedCategories')
	var err;
	var prefix = Exporter.config('prefix');
	var startms = +new Date();
	var query = 'SELECT '
		+ prefix + 'forums.forum_id as _cid, '
		+ prefix + 'forums.forum_name as _name, '
		+ prefix + 'forums.forum_desc as _description, '
		+ prefix + 'forums.forum_parents as _parentCid '
		+ 'FROM ' + prefix + 'forums '
		+  (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

	if (!Exporter.connection) {
		err = {error: 'MySQL connection is not setup. Run setup(config) first'};
		Exporter.error(err.error);
		throw err
	}

	const rows = await executeQuery(query)

	//normalize here
	var map = {};
	rows.forEach(function(row) {
		row._name = row._name || 'Untitled Category';
		row._description = row._description || '';
		row._timestamp = ((row._timestamp || 0) * 1000) || startms;
		try {
			row._parentCid = Number(row._parentCid.split(':')[3].split(';')[0])
		} catch(e) {
			row._parentCid = undefined
		}

		map[row._cid] = row;
	});

	return map
};

Exporter.getTopics = () => Exporter.getPaginatedTopics(0, -1)

Exporter.getPaginatedTopics = async (start, limit) => {
	Exporter.log('getPaginatedTopics')
	var err;
	var prefix = Exporter.config('prefix');
	var startms = +new Date();
	var query =
		'SELECT '
		+ prefix + 'topics.topic_id as _tid, '
		+ prefix + 'topics.forum_id as _cid, '

		// this is the 'parent-post'
		// see https://github.com/akhoury/nodebb-plugin-import#important-note-on-topics-and-posts
		// I don't really need it since I just do a simple join and get its content, but I will include for the reference
		// remember this post EXCLUDED in the exportPosts() function
		+ prefix + 'topics.topic_first_post_id as _pid, '

		+ prefix + 'topics.topic_views as _viewcount, '
		+ prefix + 'topics.topic_title as _title, '
		+ prefix + 'topics.topic_time as _timestamp, '

		// maybe use that to skip
		// + prefix + 'topics.topic_approved as _approved, '

		+ prefix + 'topics.topic_status as _status, '

		//+ prefix + 'TOPICS.TOPIC_IS_STICKY as _pinned, '
		+ prefix + 'posts.poster_id as _uid, '
		// this should be == to the _tid on top of this query
		+ prefix + 'posts.topic_id as _post_tid, '

		// and there is the content I need !!
		+ prefix + 'posts.post_text as _content '

		+ 'FROM ' + prefix + 'topics, ' + prefix + 'posts '
		// see
		+ 'WHERE ' + prefix + 'topics.topic_first_post_id=' + prefix + 'posts.post_id '
		+ (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

	if (!Exporter.connection) {
		err = {error: 'MySQL connection is not setup. Run setup(config) first'};
		Exporter.error(err.error);
		throw err
	}

	const rows = await executeQuery(query)

	//normalize here
	var map = {};
	rows.forEach(function(row) {
		row._title = row._title ? row._title[0].toUpperCase() + row._title.substr(1) : 'Untitled';
		row._timestamp = ((row._timestamp || 0) * 1000) || startms;

		map[row._tid] = row;
	});

	return map
};

var getTopicsMainPids = async () => {
	if (Exporter._topicsMainPids) {
		return Exporter._topicsMainPids
	}
	const topicsMap = await Exporter.getPaginatedTopics(0, -1)

	Exporter._topicsMainPids = {};
	Object.keys(topicsMap).forEach(function(_tid) {
		var topic = topicsMap[_tid];
		Exporter._topicsMainPids[topic.topic_first_post_id] = topic._tid;
	});
	return Exporter._topicsMainPids
};

Exporter.getPosts = () => Exporter.getPaginatedPosts(0, -1)

Exporter.getPaginatedPosts = async (start, limit) => {
	Exporter.log('getPaginatedPosts')
	var err;
	var prefix = Exporter.config('prefix');
	var startms = +new Date();
	var query =
		'SELECT ' + prefix + 'posts.post_id as _pid, '
		//+ 'POST_PARENT_ID as _post_replying_to, ' phpbb doesn't have "reply to another post"
		+ prefix + 'posts.topic_id as _tid, '
		+ prefix + 'posts.post_time as _timestamp, '
		// not being used
		+ prefix + 'posts.post_subject as _subject, '

		+ prefix + 'posts.post_text as _content, '
		+ prefix + 'posts.poster_id as _uid '

		// maybe use this one to skip
		//+ prefix + 'posts.post_approved as _approved '

		+ 'FROM ' + prefix + 'posts '

		// the ones that are topics main posts are filtered below
		+ 'WHERE ' + prefix + 'posts.topic_id > 0 '
		+ (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

	if (!Exporter.connection) {
		err = {error: 'MySQL connection is not setup. Run setup(config) first'};
		Exporter.error(err.error);
		throw err
	}

	const rows = await executeQuery(query)

	const mpids = await getTopicsMainPids()

	//normalize here
	var map = {};
	rows.forEach(function (row) {
		// make it's not a topic
		if (! mpids[row._pid]) {
			row._content = row._content || '';
			console.log(row._content)
			row._timestamp = ((row._timestamp || 0) * 1000) || startms;
			map[row._pid] = row;
		}
	});
	return map
};

Exporter.teardown = () => {
	Exporter.log('teardown');
	Exporter.connection.end();

	Exporter.log('Done');
};

Exporter.testrun = async (config) => {
	await Exporter.setup(config)
	await Exporter.getUsers()
	await Exporter.getCategories()
	await Exporter.getTopics()
	await Exporter.getPosts()
	await Exporter.teardown()
};

Exporter.paginatedTestrun = async (config) => {
	Exporter.setup(config)
	Exporter.getPaginatedUsers(0, 1000)
	Exporter.getPaginatedCategories(0, 1000)
	Exporter.getPaginatedTopics(0, 1000)
	Exporter.getPaginatedPosts(1001, 2000)
	Exporter.teardown()
};

Exporter.warn = function() {
	var args = _.toArray(arguments);
	args.unshift(logPrefix);
	console.warn.apply(console, args);
};

Exporter.log = function() {
	var args = _.toArray(arguments);
	args.unshift(logPrefix);
	console.log.apply(console, args);
};

Exporter.error = function() {
	var args = _.toArray(arguments);
	args.unshift(logPrefix);
	console.error.apply(console, args);
};

Exporter.config = function(config, val) {
	if (config != null) {
		if (typeof config === 'object') {
			Exporter._config = config;
		} else if (typeof config === 'string') {
			if (val != null) {
				Exporter._config = Exporter._config || {};
				Exporter._config[config] = val;
			}
			return Exporter._config[config];
		}
	}
	return Exporter._config;
};

// from Angular https://github.com/angular/angular.js/blob/master/src/ng/directive/input.js#L11
Exporter.validateUrl = function(url) {
	var pattern = /^(ftp|http|https):\/\/(\w+:{0,1}\w*@)?(\S+)(:[0-9]+)?(\/|\/([\w#!:.?+=&%@!\-\/]))?$/;
	return url && url.length < 2083 && url.match(pattern) ? url : '';
};

Exporter.truncateStr = function(str, len) {
	if (typeof str != 'string') return str;
	len = _.isNumber(len) && len > 3 ? len : 20;
	return str.length <= len ? str : str.substr(0, len - 3) + '...';
};

Exporter.whichIsFalsy = function(arr) {
	for (var i = 0; i < arr.length; i++) {
		if (!arr[i])
			return i;
	}
	return null;
};
