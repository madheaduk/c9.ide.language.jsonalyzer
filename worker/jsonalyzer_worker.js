/*
 * jsonalyzer worker
 *
 * @copyright 2012, Ajax.org B.V.
 * @author Lennart Kats <lennart add c9.io>
 */
define(function(require, exports, module) {

var baseLanguageHandler = require("plugins/c9.ide.language/base_handler");
var index = require("./semantic_index");
var assert = require("c9/assert");
var jumptodef = require("./jumptodef");
var complete = require("./complete");
var outline = require("./outline");
var refactor = require("./refactor");
var highlight = require("./highlight_occurrences");
var scopeAnalyzer = require('plugins/c9.ide.language.javascript/scope_analyzer');
var directoryIndexer = require("./directory_indexer");
var fileIndexer = require("./file_indexer");
var ctagsUtil = require("plugins/c9.ide.language.jsonalyzer/worker/ctags/ctags_util");
var ctagsEx =  require("plugins/c9.ide.language.jsonalyzer/worker/ctags/ctags_ex");
var HandlerRegistry = require("plugins/c9.ide.language.jsonalyzer/worker/handler_registry").HandlerRegistry;
require("treehugger/traverse"); // add traversal methods

var worker = module.exports = Object.create(baseLanguageHandler);
var isOnline = false;
var isInWebWorker = typeof window == "undefined" || !window.location || !window.document;
var handlers = new HandlerRegistry();

worker.$isInited = false;
worker.DEBUG = true;
worker.KIND_DEFAULT = scopeAnalyzer.KIND_DEFAULT;
worker.KIND_PACKAGE = scopeAnalyzer.KIND_PACKAGE;
worker.GUID_PREFIX = "project:";

worker.init = function(callback) {
    var _self = this;
    
    worker.sender.on("onlinechange", function(event) {
        _self.onOnlineChange(event);
    });
    worker.sender.on("filechange", function(event) {
        _self.onFileChange(event);
    });
    worker.sender.on("dirchange", function(event) {
        _self.onDirChange(event);
    });
    worker.sender.on("jsonalyzerRegister", function(event) {
        _self.loadPlugin(event.data.modulePath, event.data.contents, function(err, plugin) {
            if (err) return console.error(err);
            plugin.$source = event.data.modulePath;
            handlers.registerPlugin(plugin, _self);
            worker.sender.emit("jsonalyzerRegistered", { modulePath: event.data.modulePath, err: err });
        });
    });
    
    directoryIndexer.init(this);
    fileIndexer.init(this);
    index.init(this);
    jumptodef.init(this);
    complete.init(this);
    outline.init(this);
    refactor.init(this);
    highlight.init(this);
    ctagsUtil.init(ctagsEx, this);
    
    // Calling the callback to register/activate the plugin
    // (calling it late wouldn't delay anything else)
    callback();
};

worker.loadPlugin = function(modulePath, contents, callback) {
    // This follows the same approach as c9.ide.language/worker.register();
    // see the comments there for more background.
    if (contents) {
        try {
            eval.call(null, contents);
        } catch (e) {
            return callback("Could not load language handler " + modulePath + ": " + e);
        }
    }
    var handler;
    try {
        handler = require(modulePath);
        if (!handler)
            throw new Error("Unable to load required module: " + modulePath);
    } catch (e) {
        if (isInWebWorker)
            return callback("Could not load language handler " + modulePath + ": " + e);
        
        // In ?noworker=1 debugging mode, synchronous require doesn't work
        return require([modulePath], function(handler) {
            if (!handler)
                return callback("Could not load language handler " + modulePath);
            callback(null, handler);
        });
    }
    callback(null, handler);
};

worker.handlesLanguage = function(language) {
    return this.getPluginFor(this.path, language);
};

worker.onDocumentOpen = function(path, doc, oldPath, callback) {
    // Check path validity if inited; otherwise do check later
    if (this.$isInited && !this.getPluginFor(path, null))
        return;
    
    // Analyze any opened document to make completions more rapid
    fileIndexer.analyzeOthers([path]);
};

worker.analyze = function(doc, ast, callback, minimalAnalysis) {
    if (minimalAnalysis && index.get(worker.path))
        return callback();
    
    // Ignore embedded languages and just use the full document,
    // since we can't handle multiple segments in the index atm
    var fullDoc = this.doc.getValue();
        
    assert(worker.path);
    fileIndexer.analyzeCurrent(worker.path, fullDoc, ast, {}, function(err, result, imports) {
        if (err)
            console.error("[jsonalyzer] Warning: could not analyze " + worker.path + ": " + err);
            
        // Analyze imports without blocking other analyses
        if (imports && imports.length)
            fileIndexer.analyzeOthers(imports, true);
        
        callback(result && result.markers);
    });
};

worker.complete = complete.complete.bind(complete);

worker.outline = outline.outline.bind(outline);

worker.jumpToDefinition = jumptodef.jumpToDefinition.bind(jumptodef);

worker.getRefactorings = refactor.getRefactorings.bind(refactor);

worker.getRenamePositions = refactor.getRenamePositions.bind(refactor);

worker.commitRename = refactor.commitRename.bind(refactor);

worker.highlightOccurrences = highlight.highlightOccurrences.bind(highlight);

worker.onOnlineChange = function(event) {
    isOnline = event.data.isOnline;
},

worker.onFileChange = function(event) {
    if (worker.disabled)
        return;
    var path = event.data.path.replace(/^\/((?!workspace)[^\/]+\/[^\/]+\/)?workspace\//, "");
    
    if (!this.getPluginFor(path, null))
        return;
    
    if (event.data.isSave && path === this.path)
        return fileIndexer.analyzeCurrent(path, event.data.value, null, { isSave: true }, function() {});

    index.removeByPath(path);
    
    // We'll enqueue any files received here, since we can
    // assume they're still open if they're being watched
    fileIndexer.analyzeOthers([path]);
};

worker.onDirChange = function(event) {
    directoryIndexer.enqueue(event.data.path);
};

worker.getPluginFor = function(path, language) {
    language = language || (worker.path === path && worker.language);
    
    return handlers.getPluginFor(path, language);
};

worker.getAllPlugins = function() {
    return handlers.getAllPlugins();
};

});

