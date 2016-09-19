var async = require('async');
var mysql = require('mysql');
var _ = require('underscore');
// var Entities = require('html-entities').AllHtmlEntities;
// var entities = new Entities();
var noop = function(){};
var logPrefix = '[nodebb-plugin-import-phpbb]';
var request = require('request');

(function(Exporter) {

    Exporter.setup = function(config, callback) {
        Exporter.log('setup');

        // mysql db only config
        // extract them from the configs passed by the nodebb-plugin-import adapter
        var _config = {
            host: config.dbhost || config.host || 'localhost',
            user: config.dbuser || config.user || 'root',
            password: config.dbpass || config.pass || config.password || '',
            port: config.dbport || config.port || 3306,
            database: config.dbname || config.name || config.database || 'phpbb',

            avatarFolder: config.custom.avatarFolder || '',
            attachmentsFolder: '/uploads/files/'
        };

        Exporter.config(_config);
        Exporter.config('prefix', config.prefix || config.tablePrefix || '' /* phpbb_ ? */ );

        Exporter.connection = mysql.createConnection(_config);
        Exporter.connection.connect();

        callback(null, Exporter.config());
    };

    Exporter.getPaginatedUsers = function(start, limit, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var err;
        var prefix = Exporter.config('prefix');
        var startms = +new Date();
        var query = 'SELECT '
            + prefix + 'users.user_id AS _uid, '
            + prefix + 'users.username AS _username, '
            + prefix + 'users.username_clean AS _alternativeUsername, '
            + prefix + 'users.user_email AS _registrationEmail, '
            + prefix + 'users.user_regdate AS _joindate, '
            + prefix + 'users.user_lastvisit AS _lastonline, '
            + prefix + 'users.user_email AS _email, '
            + prefix + 'users.user_allow_viewemail AS _showemail, '
            + prefix + 'users.user_sig AS _signature, '
            + prefix + 'users.user_website AS _website, '
            + prefix + 'users.user_from AS _location, '
            + prefix + 'users.user_avatar AS _pictureFilename, '
            + prefix + 'users.user_birthday AS _birthday, '
            + 'GROUP_CONCAT( DISTINCT ' + prefix + 'user_group.group_id SEPARATOR  ":" ) AS _groups '
            + 'FROM ' + prefix + 'users '
            + 'LEFT JOIN ' + prefix + 'user_group ON ' + prefix + 'users.user_id = ' + prefix + 'user_group.user_id '
            + 'AND ' +prefix + 'users.user_posts > 0 ' // filter users who dont have at least 1 post
            + 'GROUP BY ' + prefix + 'users.user_id '
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

        if (!Exporter.connection) {
            err = {error: 'MySQL connection is not setup. Run setup(config) first'};
            Exporter.error(err.error);
            return callback(err);
        }

        Exporter.connection.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }

                //normalize here
                var map = {};
                rows.forEach(function(row) {
                    // nbb forces signatures to be less than 150 chars
                    // keeping it HTML see https://github.com/akhoury/nodebb-plugin-import#markdown-note
                    row._signature = Exporter.truncateStr(row._signature || '', 2500);
                    // from unix timestamp (s) to JS timestamp (ms)
                    row._joindate = ((row._joindate || 0) * 1000) || startms;
                    // from unix timestamp (s) to JS timestamp (ms)
                    row._lastonline = ((row._lastonline || 0) * 1000) || startms;
                    // lower case the email for consistency
                    row._email = (row._email || '').toLowerCase();

                    // location
                    row._location = (row._location || '').trim();

                    // birthday
                    row._birthday = (row._birthday || '').split(' ').join('').replace(/(\d{2})-(\d{2})-(\d{4})/, "$2/$1/$3");

                    // I don't know about you about I noticed a lot my users have incomplete urls, urls like: http://
                    row._website = Exporter.validateUrl(row._website);
                    // split groups string into array
                    row._groups = (row._groups || '').split(":");

                    map[row._uid] = row;
                });

                var getAvatarBlobs = rows.map(function(user) {
                    return function(cb) {
                        if (user._pictureFilename == '') {
                            cb();
                            return;
                        }

                        var uri = avatarFolder + user._pictureFilename;
                        request(uri, { encoding: null }, function(error, response, body) {
                            if (err || response.statusCode != 200) {
                                user._pictureFilename = '';
                                cb();
                                return;
                            }

                            user._pictureBlob = body;
                            cb();
                        });
                    };
                });

                callback(null, map);
            });
    };

    Exporter.getPaginatedGroups = function(start, limit, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var err;
        var prefix = Exporter.config('prefix');
        var adminGroup = Exporter.config('adminGroup');
        var modGroup = Exporter.config('modGroup');
        var query = 'SELECT '
            + prefix + 'groups.group_id AS _gid, '
            + prefix + 'groups.group_name AS _name, '
            // _ownerUid (handled below)
            + prefix + 'groups.group_desc AS _description '
            // _timestamp
            +'FROM ' + prefix + 'groups '
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

        if (!Exporter.connection) {
            err = { error: 'MySQL connection is not setup. Run setup(config) first' };
            Exporter.error(err.error);
            return callback(err);
        }

        Exporter.connection.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }

                // get group leader
                var map = {};
                var gids = rows.map(function(row) {
                    return row._gid;
                });
                Exporter.getGroupLeaders(gids, function(err, gLeaders) {
                    if (err) {
                        Exporter.error(err);
                        return callback(err);
                    }

                    rows.forEach(function(row) {
                        // don't add admin and moderator groups from phpbb
                        if (adminGroup != '' && parseInt(adminGroup, 10) == row._gid) {
                            return;
                        }
                        if (modGroup != '' && parseInt(modGroup, 10) == row._gid) {
                            return;
                        }

                        row._ownerUid = gLeaders[row._gid];
                        row._description = row._description || '';

                        map[row._gid] = row;
                    });
                    callback(null, map);
                });
            });
    };
    Exporter.getGroupLeaders = function(gids, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var err;
        var prefix = Exporter.config('prefix');
        var query = 'SELECT '
            + prefix + 'user_group.group_id AS _gid, '
            + prefix + 'user_group.user_id AS _uid, '
            + prefix + 'user_group.group_leader AS _leader, '
            + prefix + 'user_group.user_pending AS _pending '
            + 'FROM ' + prefix + 'user_group ';

        if (!Exporter.connection) {
            err = { error: 'MySQL connection is not setup. Run setup(config) first' };
            Exporter.error(err.error);
            return callback(err);
        }

        Exporter.connection.query(query,
            function(err, userGroup) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }

                var leaders = {};
                gids.forEach(function(gid) {
                    userGroup.some(function(ug) {
                        if (gid == ug._gid && ug._leader == 1) {
                            leaders[gid] = ug._uid;
                            return true;
                        }
                        return false;
                    });

                    if (leaders[gid] == undefined) {
                        userGroup.some(function(ug) {
                            if (gid == ug._gid && ug._pending != 1) {
                                leaders[gid] = ug._uid;
                                return true;
                            }
                            return false;
                        });
                    }
                });

                callback(null, leaders);
            });
    };

//    Exporter.getPaginatedMessages = function(start, limit, callback) {
//        callback = !_.isFunction(callback) ? noop : callback;
//
//        var err;
//        var prefix = Exporter.config('prefix');
//        var startms = +new Date();
//        var query = 'SELECT '
//            + prefix + 'privmsgs.msg_id AS _mid, '
//            + prefix + 'privmsgs.author_id AS _fromuid, '
//            + prefix + 'privmsgs.to_address AS _touid, '
//            + prefix + 'privmsgs.message_text AS _content, '
//            + prefix + 'privmsgs.message_time AS _timestamp '
//            + 'FROM ' + prefix + 'privmsgs '
//            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');
//
//            if(!Exporter.connection) {
//                err = {error: 'MySQL connection is not setup. Run setup(config) first'};
//                Exporter.error(err.error);
//                return callback(err);
//            }
//
//            Exporter.connection.query(query,
//                function(err, rows) {
//                    if (err) {
//                        Exporter.error(err);
//                        return callback(err);
//                    }
//
//                    var map = {};
//                    rows.forEach(function(row) {
//                        // this replaces the strange phpbb uid with a simple single number
//                        // please note that this also removes additional targets the message has been sent to
//                        // nodebb currently doesn't allow to send chats to multiple users
//                        row._touid = row._touid.replace(/^u_([^:]+)(:.*)?$/, "$1");
//                        row._content = row._content || '';
//                        row._timestamp = ((row._timestamp || 0) * 1000) || startms;
//
//                        map[row._mid] = row;
//                    });
//
//                    callback(null, map);
//                });
//    };

    Exporter.getPaginatedCategories = function(start, limit, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var err;
        var prefix = Exporter.config('prefix');
        var startms = +new Date();
        var query = 'SELECT '
            + prefix + 'forums.forum_id AS _cid, '
            + prefix + 'forums.parent_id AS _parentCid, '
            + prefix + 'forums.forum_name AS _name, '
            + prefix + 'forums.forum_desc AS _description '
            + 'FROM ' + prefix + 'forums '
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

        if (!Exporter.connection) {
            err = {error: 'MySQL connection is not setup. Run setup(config) first'};
            Exporter.error(err.error);
            return callback(err);
        }

        Exporter.connection.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }

                //normalize here
                var map = {};
                rows.forEach(function(row) {
                    // row._name = entities.decode(row._name || 'Untitled Category');
                    // row._description = entities.decode(row._description || 'No decscription available');
                    row._name = row._name || 'Untitled Category';
                    row._description = row._description || 'No decscription available';
                    row._timestamp = ((row._timestamp || 0) * 1000) || startms;

                    map[row._cid] = row;
                });

                callback(null, map);
            });
    };

    Exporter.getPaginatedTopics = function(start, limit, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var err;
        var prefix = Exporter.config('prefix');
        var startms = +new Date();
        var query = 'SELECT '
            + prefix + 'topics.topic_id AS _tid, '
            + prefix + 'topics.forum_id AS _cid, '
            + prefix + 'topics.topic_first_post_id AS _pid, '
            + prefix + 'topics.topic_views AS _viewcount, '
            + prefix + 'topics.topic_title AS _title, '
            + prefix + 'topics.topic_time AS _timestamp, '
            + prefix + 'posts.post_edit_time AS _edited, '
            // below are aux vars used for setting other vars
            + prefix + 'topics.topic_approved AS _approved, '
            + prefix + 'topics.topic_status AS _status, '
            + prefix + 'topics.topic_attachment AS _hasattachments, '
            + prefix + 'topics.topic_type AS _type, '
            + prefix + 'posts.poster_id AS _uid, '
            + prefix + 'posts.poster_ip AS _ip, '
            // this should be == to the _tid on top of this query
            + prefix + 'posts.topic_id AS _post_tid, '
            + prefix + 'posts.post_text AS _content '

            + 'FROM ' + prefix + 'topics '
            + 'LEFT JOIN ' + prefix + 'posts ON ' + prefix + 'topics.topic_first_post_id = ' + prefix + 'posts.post_id '
            + 'GROUP BY ' + prefix + 'topics.topic_id '
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

        if (!Exporter.connection) {
            err = {error: 'MySQL connection is not setup. Run setup(config) first'};
            Exporter.error(err.error);
            return callback(err);
        }

        Exporter.connection.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }

                var map = {};
                var topicWork = rows.map(function(row) {
                    return function(cb) {
                        //normalize here
                        row._title = row._title ? row._title[0].toUpperCase() + row._title.substr(1) : 'Untitled';
                        row._timestamp = ((row._timestamp || 0) * 1000) || startms;
                        row._edited = ((row._edited || 0) * 1000) || 0;
                        row._locked = (row._status == 1) ? 1 : 0;
                        row._deleted = (row._approved == 0) ? 1 : 0;
                        row._pinned = (row._type > 0) ? 1 : 0;
                        row._content = (row._content || 'no text');

                        Exporter.getPostAttachments(row, 0, function(err, row_wAttachments) {
                            if (err) {
                                Exporter.error(err);
                                return callback(err);
                            }

                            map[row_wAttachments._tid] = row_wAttachments;
                            cb();
                        });
                    };
                });
                async.parallel(topicWork, function(err) {
                    callback(err, map);
                });
            });
    };

    Exporter.getPaginatedPosts = function(start, limit, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var err;
        var prefix = Exporter.config('prefix');
        var startms = +new Date();
        var query = 'SELECT '
            + prefix + 'posts.post_id AS _pid, '
            + prefix + 'posts.topic_id AS _tid, '
            + prefix + 'posts.post_time AS _timestamp, '
            + prefix + 'posts.post_edit_time AS _edited, '
            + prefix + 'posts.post_subject AS _subject, '
            + prefix + 'posts.post_text AS _content, '
            + prefix + 'posts.poster_id AS _uid, '
            + prefix + 'posts.poster_ip AS _ip, '
            + prefix + 'posts.post_attachment AS _hasattachments, '
            // maybe use this one to skip
            + prefix + 'posts.post_approved AS _approved '

            + 'FROM ' + prefix + 'posts '

            // join for topic main post exclution
            + 'LEFT JOIN ' + prefix + 'topics ON ' + prefix + 'posts.post_id = ' + prefix + 'topics.topic_first_post_id '
            + 'WHERE ' + prefix + 'posts.topic_id > 0 AND ' + prefix + 'topics.topic_first_post_id IS NULL '
            + 'GROUP BY ' + prefix + 'posts.post_id '
            + (start >= 0 && limit >= 0 ? 'LIMIT ' + start + ',' + limit : '');

        if (!Exporter.connection) {
            err = {error: 'MySQL connection is not setup. Run setup(config) first'};
            Exporter.error(err.error);
            return callback(err);
        }

        Exporter.connection.query(query,
            function (err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }
                var map = {};
                var postWork = rows.map(function(row) {
                    return function(cb) {
                        //normalize here
                        row._content = row._content || '';
                        row._timestamp = ((row._timestamp || 0) * 1000) || startms;
                        row._edited = ((row._edited || 0) * 1000) || startms;
                        row._groups = (row._groups || '').split(",");

                        Exporter.getPostAttachments(row, 0, function(err, row_wAttachments) {
                            if (err) {
                                Exporter.error(err);
                                return callback(err);
                            }

                            map[row_wAttachments._pid] = row_wAttachments;
                            cb();
                        });
                    };
                });

                async.parallel(postWork, function(err) {
                    callback(err, map);
                });
            });
    };

    Exporter.getPostAttachments = function(post, pmAttachment, callback) {
        callback = !_.isFunction(callback) ? noop : callback;

        var attachmentsFolder = Exporter.config('attachmentsFolder');
        if (attachmentsFolder == '') {
            callback(err, null);
            return;
        }

        var err;
        var prefix = Exporter.config('prefix');
        var query = 'SELECT '
            + prefix + 'attachments.attach_id AS _aid, '
            + prefix + 'attachments.post_msg_id AS _pid, '
            + prefix + 'attachments.poster_id AS _posterid, '
            + prefix + 'attachments.extension AS _extension, '
            + prefix + 'attachments.real_filename AS _name, '
            + prefix + 'attachments.physical_filename AS _loc, '
            + prefix + 'attachments.attach_comment AS _comment, '
            + prefix + 'attachments.is_orphan AS _orphan '
            + 'FROM ' + prefix + 'attachments '
            + 'WHERE ' + prefix + 'attachments.post_msg_id = ' + post._pid + ' AND ' + prefix + 'attachments.in_message = ' + pmAttachment;

        if (!Exporter.connection) {
            err = { error: 'MySQL connection is not setup. Run setup(config) first' };
            Exporter.error(err.error);
            return callback(err);
        }

        Exporter.connection.query(query,
            function(err, rows) {
                if (err) {
                    Exporter.error(err);
                    return callback(err);
                }

                if (rows.length > 0) {
                    post._attachments = new Array();

                    rows.forEach(function(row) {
                        var newAttachmentName = row._posterid + "_" + row._aid + "." + row._extension;
                        var attachmentPath = attachmentsFolder + newAttachmentName;
                        var attachmentComment = row._comment.length > 0 ? row._comment : newAttachmentName;
                        var inlineRegexp = new RegExp("\\[attachment=\\d+:[^\\]]+\\]<!-- ia\\d+ -->" + row._name.replace(/\//g, "\\/").replace(/\./g, "\\.").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\$/g, "\\$") + "<!-- ia\\d+ -->\\[\\/attachment:[^\\]]+\\]", "g");

                        if (post._content.match(inlineRegexp)) {
                            post._content = post._content.replace(inlineRegexp, "![" + newAttachmentName + "](" + attachmentPath + ")");
                        } else {
                            post._attachments.push(attachmentPath);
                        }
                    });
                }

                callback(null, post);
            });
    };

    Exporter.teardown = function(callback) {
        Exporter.log('teardown');
        Exporter.connection.end();

        Exporter.log('Done');
        callback();
    };

    Exporter.paginatedTestrun = function(config, callback) {
        async.series([
            function(next) {
                Exporter.setup(config, next);
            },
            function(next) {
                Exporter.getPaginatedUsers(0, 1000, next);
            },
            function(next) {
                Exporter.getPaginatedGroups(0, 1000, next);
            },
            function(next) {
                Exporter.getPaginatedMessages(0, 1000, next);
            },
            function(next) {
                Exporter.getPaginatedCategories(0, 1000, next);
            },
            function(next) {
                Exporter.getPaginatedTopics(0, 1000, next);
            },
            function(next) {
                Exporter.getPaginatedPosts(1001, 2000, next);
            },
            function(next) {
                Exporter.teardown(next);
            }
        ], callback);
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


})(module.exports);
