/*
 * jsonalyzer multi-file analysis plugin
 *
 * @copyright 2013, Ajax.org B.V.
 * @author Lennart Kats <lennart add c9.io>
 */
define(function(require, exports, module) {
    
    main.consumes = [
        "Plugin", "commands", "language", "c9", "watcher",
        "save", "language.complete", "dialog.error", "ext",
        "collab", "collab.connect", "language.worker_util_helper",
        "error_handler"
    ];
    main.provides = [
        "jsonalyzer"
    ];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var plugin = new Plugin("Ajax.org", main.consumes);
        var emit = plugin.getEmitter();
        var c9 = imports.c9;
        var language = imports.language;
        var watcher = imports.watcher;
        var save = imports.save;
        var showError = imports["dialog.error"].show;
        var hideError = imports["dialog.error"].hide;
        var errorHandler = imports.error_handler;
        var ext = imports.ext;
        var plugins = require("./default_plugins");
        var async = require("async");
        var collab = imports.collab;
        var collabConnect = imports["collab.connect"];
        var readTabOrFile = imports["language.worker_util_helper"].readTabOrFile;

        var extendToken = options.extendToken;
        var useCollab = options.useCollab;
        var useSend = !options.useCollab && options.useSend;
        var maxTrySeriesLength = options.maxTrySeriesLength || 3;
        var maxTrySeriesTime = options.maxTrySeriesTime || 10000;
        var homeDir = options.homeDir.replace(/\/$/, "");
        var workspaceDir = options.workspaceDir.replace(/\/$/, "");
        var serverOptions = {};
        for (var o in options) {
            if (typeof options[o] !== "function" && options.hasOwnProperty(o))
                serverOptions[o] = options[o];
        }
        
        var worker;
        var server;
        var pendingServerCall;
        var lastServerCall = Date.now();
        var serverLoading = false;
        
        var loaded = false;
        function load() {
            if (loaded) return false;
            loaded = true;
            
            var loadedWorker;
            var warning;
            
            emit.setMaxListeners(50);
            
            // Load worker
            language.registerLanguageHandler(
                "plugins/c9.ide.language.jsonalyzer/worker/jsonalyzer_worker",
                function(err, langWorker) {
                    if (err) {
                        errorHandler.reportError(err);
                        return showError("Could not load language worker: " + (err.message | err));
                    }
                    loadedWorker = true;
                    worker = langWorker;
                    watcher.on("change", onFileChange);
                    watcher.on("directory", onDirChange);
                    save.on("afterSave", onFileSave);
                    c9.on("connect", onOnlineChange);
                    c9.on("disconnect", onOnlineChange);
                    worker.on("jsonalyzerCallServer", callServer);
                    worker.emit("onlinechange", {data: { isOnline: c9.connected }});
                    emit.sticky("initWorker");
                    if (warning)
                        hideError(warning);
                }
            );
            setTimeout(function() {
                setTimeout(function() { // wait a bit longer in case we were in the debugger
                    if (!loadedWorker)
                        warning = showError("Language worker could not be loaded; some language features have been disabled");
                }, 50);
            }, 60000);
                                        
            plugins.handlersWorker.forEach(function(plugin) {
                registerWorkerHandler(plugin);
            });
            
            // Load server
            if (!useSend && !useCollab) {
                console.warn("jsonalyzer disabled");
                serverLoading = true; // disable loading
                return;
            }
            loadServer(function(err) {
                if (err) {
                    showError("Language server could not be loaded; some language features have been disabled");
                    return console.error(err.stack || err);
                }
            });
        }
        
        function loadServer(callback) {
            if (serverLoading)
                plugin.once("initServer", callback);
            
            tryConnect();
            
            function tryConnect() {
                var loadedHandlers = [];
                var handlersForWorker = [];
                
                async.series([
                    function extendVFS(next) {
                        ext.loadRemotePlugin(
                            "jsonalyzer_server",
                            {
                                code: require("text!./server/jsonalyzer_server.js"),
                                extendToken: extendToken,
                                redefine: !server
                            },
                            function onExtendVFS(err, _server) {
                                if (err && err.code === "EEXIST")
                                    err = null;
                                server = _server;
                                next(err);
                            }
                        );
                    },
                    function getLoadedHandlers(next) {
                        server.getHandlerList(function(err, result) {
                            loadedHandlers = result && result.handlers;
                            next(err);
                        });
                    },
                    function loadHelpers(next) {
                        var helpers = plugins.helpersServer.filter(function(p) {
                            return loadedHandlers.indexOf(p.path) === -1;
                        });
                        if (!helpers.length)
                            return next();
                        server.registerHandlers(helpers, serverOptions, next);
                    },
                    function loadHandlers(next) {
                        var handlers = plugins.handlersServer.filter(function(p) {
                            return loadedHandlers.indexOf(p.path) === -1;
                        });
                        if (!handlers.length)
                            return next();
                        server.registerHandlers(handlers, serverOptions, function(err, result) {
                            if (err) return next(err);
                            
                            handlersForWorker = result.summaries;
                            next(err);
                        });
                    },
                    function waitForCollab(next) {
                        if (!useCollab) return next();
                        var wait = setTimeout(function() {
                            done(new Error("Collab never gets to available state"));
                        }, 20000);
                        collabConnect.once("available", function() {
                            clearTimeout(wait);
                            next();
                        });
                    },
                    function callInit(next) {
                        server.init(serverOptions, next);
                    },
                    function notifyWorker(next) {
                        plugin.once("initWorker", function() {
                            handlersForWorker.forEach(function(meta) {
                                if (loadedHandlers.indexOf(meta.path) > -1)
                                    return;
                                worker.emit("jsonalyzerRegisterServer", { data: meta });
                            });
                            next();
                        });
                    },
                ], done);
            }
            
            function done(err) {
                if (err && err.code === "EDISCONNECT" || !err && !c9.connected)
                    return tryConnect();
                if (err)
                    return callback(err); // fatal; don't reset serverLoading
                
                serverLoading = false;
                
                emit.sticky("initServer");
                callback();
            }
        }
        
        function onFileChange(event) {
            if (worker)
                worker.emit("filechange", {data: {path: event.path}});
        }
        
        function onFileSave(event) {
            if (!event.silentsave)
                worker.emit("filechange", {data: {path: event.path, value: event.document && event.document.value, isSave: true}});
        }
        
        function onDirChange(event) {
            if (worker)
                worker.emit("dirchange", {data: event});
        }
        
        function onOnlineChange(event) {
            plugin.once("initWorker", function(err) {
                if (err)
                    console.error(err);
                    
                worker.emit("onlinechange", {data: { isOnline: c9.connected }});
            });
            
            if (!c9.connected) {
                emit.unsticky("initServer");
                return;
            }
            
            // Reconnect to server
            console.log("[jsonalyzer] connecting");
            loadServer(function(err) {
                if (err)
                    return console.error("Could not reload language server", err);
                console.log("[jsonalyzer] connected");
            });
        }
        
        function callServer(event) {
            var filePath = event.data.filePath;
            var handlerPath = event.data.handlerPath;
            var method = event.data.method;
            var args = event.data.args;
            var maxCallInterval = event.data.maxCallInterval || 2000;
            var value;
            var revNum;
            var tries = [];
            
            setupCall();
            
            function setupCall() {
                // Throttle server calls
                var waitTime = lastServerCall + maxCallInterval - Date.now();
                if (waitTime > 0)
                    return setTimeout(setupCall, waitTime);
                lastServerCall = Date.now();
                
                if (useCollab) {
                    var collabDoc = collab.getDocument(filePath);
                    if (collabDoc) {
                        revNum = collabDoc.latestRevNum + (collabDoc.pendingUpdates ? 1 : 0);
                        collabDoc.sendNow();
                    }
                    return start();
                }
                
                if (!useSend)
                    return console.warn("Can't enable server-side analysis without collab in this configuration");
                
                return readTabOrFile(
                    filePath,
                    { allowUnsaved: true, encoding: "utf-8" },
                    function(err, result) {
                        if (err) return done(err);
                        
                        value = result;
                        start();
                    }
                );
                
                function start() {
                    pendingServerCall = doCall;
                    plugin.once("initServer", pendingServerCall);
                }
            }
                
            function doCall() {
                if (pendingServerCall !== doCall) {
                    var err = new Error("Superseded by later call, aborted");
                    err.code = "ESUPERSEDED";
                    return done(err);
                }
                
                var watcher = setTimeout(function watch() {
                    if (!c9.connected)
                        return plugin.once("initServer", function() { setTimeout(watch, 2000) });
                    console.warn("Did not receive a response from handler call to " + handlerPath + ":" + method);
                }, 15000);
                
                server.callHandler(
                    handlerPath, method, args,
                    {
                        filePath: toOSPath(filePath),
                        value: value,
                        revNum: revNum
                    },
                    function(err, response) {
                        clearTimeout(watcher);
                        done(err, response);
                    }
                );
            }
            
            function done(err, response) {
                if (err && err.code == "EDISCONNECT")
                    return setTimeout(retryConnect, 50); // try again
                
                var resultArgs = response && response.result || [err];
                resultArgs[0] = resultArgs[0] || err;
                if (err && err.code === "EFATAL")
                    errorHandler.reportError(err);
                plugin.once("initWorker", function() {
                    worker.emit(
                        "jsonalyzerCallServerResult",
                        { data: {
                            handlerPath: handlerPath,
                            result: resultArgs,
                            id: event.data.id
                        } }
                    );
                });
            }
            
            function retryConnect() {
                // If our server plugin has an exception, it might crash the server;
                // we keep track of disconnects to make sure we don't make it unusable
                tries.push(Date.now());
                var trySeriesStart = tries[tries.length - 1 - maxTrySeriesLength];
                if (!trySeriesStart || trySeriesStart < Date.now() - maxTrySeriesTime)
                    return setupCall(value);
                
                var err = new Error("Too many disconnects. Server crashing?");
                err.code = "EFATAL";
                errorHandler.reportError(err);
                done(err);
            }
        }
        
        function toOSPath(path) {
            return path
                .replace(/^\//, workspaceDir + "/")
                .replace(/^~\//, homeDir + "/");
        }
               
        function registerServerHandler(path, contents, options, callback) {
            if (typeof contents !== "string")
                return require(["text!" + path + ".js"], function(value) {
                    registerServerHandler(path, value, contents, options);
                });
            if (typeof options === "function")
                return registerServerHandler(path, contents, {}, options);
            
            plugin.once("initServer", function() {
                server.registerHandler(path, contents, options, function(err, meta) {
                    if (err && err.code === "EDISCONNECT") { // try again
                        return setTimeout(
                            registerServerHandler.bind(null, path, contents, options, callback),
                            500
                        );
                    }
                    if (err) {
                        console.error("Failed to load " + path, err);
                        return callback && callback(err);
                    }
                    
                    // Persist in case of server restart
                    plugins.handlersServer.push({
                        path: path,
                        contents: contents,
                        options: options || {}
                    });
                    
                    plugin.once("initWorker", function() {
                        worker.emit("jsonalyzerRegisterServer", { data: meta });
                        callback && callback();
                    });
                });
            });
        }
               
        function registerServerHelper(path, contents, options, callback) {
            if (typeof contents !== "string")
                return require(["text!" + path + ".js"], function(value) {
                    registerServerHelper(path, value, contents, options);
                });
            if (typeof options === "function")
                return registerServerHelper(path, contents, {}, options);
            
            plugin.once("initServer", function() {
                server.registerHandler(path, contents, options, function(err) {
                    if (err) {
                        console.error("Failed to load " + path, err);
                        callback && callback(err);
                    }
                    
                    // Persist in case of server restart
                    plugins.handlersServer.push({
                        path: path,
                        contents: contents,
                        options: options || {}
                    });
                    
                    callback && callback();
                });
            });
        }
        
        function registerWorkerHandler(path, contents, options, callback) {
            if (contents && typeof contents !== "string")
                return registerWorkerHandler(path, null, arguments[1], arguments[2]);
            if (typeof options === "function")
                return registerWorkerHandler(path, contents, {}, options);
            
            language.getWorker(function(err, worker) {
                plugin.once("initWorker", function() {
                    if (err) return console.error(err);
                    
                    worker.emit("jsonalyzerRegister", { data: {
                        modulePath: path,
                        contents: contents,
                        options: options
                    }});
                    
                    worker.on("jsonalyzerRegistered", function listen(e) {
                        if (e.data.modulePath !== path)
                            return;
                        worker.off(listen);
                        callback && callback(e.err);
                    });
                });
            });
        }
        
        plugin.on("load", function(){
            load();
        });
        
        /**
         * The jsonalyzer analysis infrastructure.
         * 
         * @singleton
         * @ignore Experimental.
         */
        plugin.freezePublicAPI({
            /**
             * Register a new web worker-based handler.
             * 
             * @param {String} path
             * @param {String} [contents]
             * @param {Object} [options]
             * @param {Function} [callback]
             */
            registerWorkerHandler: registerWorkerHandler,
            
            /**
             * Register a new server-based handler.
             *
             * @param {String} path
             * @param {String} [contents]
             * @param {Object} [options]
             * @param {Function} [callback]
             */
            registerServerHandler: registerServerHandler,
            
            /**
             * Register a new server-based handler helper.
             *
             * @param {String} path
             * @param {String} [contents]
             * @param {Object} [options]
             * @param {Function} [callback]
             */
            registerServerHelper: registerServerHelper
        });
        
        register(null, { jsonalyzer: plugin });
    }
});