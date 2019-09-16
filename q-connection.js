var Q = require("bluebird-q");
var LruMap = require("collections/lru-map");
var Map = require("collections/map");
var UUID = require("./lib/uuid");
var adapt = require("./adapt");


// Function.prototype._apply = Function.prototype.apply;

// Function.prototype.apply = function(thisArg, argsArray) {

//     if(argsArray && typeof argsArray.length !== "number") {
//         console.error("call to Function.prototype.apply with thisArg:",thisArg," argsArray:",argsArray," will throw");
//     }
//     try {
//         return this._apply(thisArg, argsArray)
//     }
//     catch(error) {
//         console.error("Function.prototype.apply error: ",error );
//     }
// };

/**
 * Constructs a Promise with a promise descriptor object and optional fallback
 * function.  The descriptor contains methods like when(rejected), get(name),
 * set(name, value), post(name, args), and delete(name), which all
 * return either a value, a promise for a value, or a rejection.  The fallback
 * accepts the operation name, a resolver, and any further arguments that would
 * have been forwarded to the appropriate method above had a method been
 * provided with the proper name.  The API makes no guarantees about the nature
 * of the returned object, apart from that it is usable whereever promises are
 * bought and sold.
 */
Q.makePromise = function makePromise(descriptor, fallback, inspect) {
    if (fallback === void 0) {
        fallback = function (op) {
            return reject(new Error(
                "Promise does not support operation: " + op
            ));
        };
    }
    if (inspect === void 0) {
        inspect = function () {
            return {state: "unknown"};
        };
    }

    //var promise = Object.create(Promise.prototype);
    var promise = Q.resolve(true);

    promise.get = function () {
        var result = promise.dispatch("get", Array.prototype.slice.call(arguments));
        result.dispatch = promise.dispatch;
        result.invoke = result.post = function () {
            var args = Array.prototype.slice.call(arguments);

            return result.then(function(resolvedValue) {
                //This is the id of the remote object we want to talk to:
                return promise.dispatch("post", args,resolvedValue["@"]);
            });
        };

        return result;
    };

    promise.post = function () {
        var args = Array.prototype.slice.call(arguments),
            self = this,
            result = this.then(function(resolvedValue) {
            console.log("post ", args, " resolved valeu is ",resolvedValue);

            var nextPromise =  self.dispatch("post", args);
            nextPromise.get = promise.get;
            nextPromise.post = promise.post;
            nextPromise.invoke = promise.invoke;
            nextPromise.dispatch = promise.dispatch;
            return nextPromise;
        });

        result.get = promise.get;
        result.post = promise.post;
        result.invoke = promise.invoke;
        result.dispatch = promise.dispatch;

        return result;
    };

    promise.invoke = function () {
        var args = Array.prototype.slice.call(arguments);

        return this.then(function(resolvedValue) {
            //resolvedValue contains the id of the remote object we want to talk to:
            return promise.dispatch("post", args,resolvedValue["@"]);
        });
    };

    promise.dispatch = function (op, args, localIdArgument) {
        var result;
        try {
            if (descriptor[op]) {
                result = descriptor[op].apply(promise, args);
            } else {
                result = fallback.call(promise, op, args, localIdArgument);
            }
            return result;

        } catch (exception) {
            return Promise.reject(exception);
        }
    };

    promise.inspect = inspect;

    // XXX deprecated `valueOf` and `exception` support
    if (inspect) {
        var inspected = inspect();
        if (inspected.state === "rejected") {
            promise.exception = inspected.reason;
        }

        promise.valueOf = function () {
            var inspected = inspect();
            if (inspected.state === "pending" ||
                inspected.state === "rejected") {
                return promise;
            }
            return inspected.value;
        };
    }

    return promise;
}

function debug() {
    typeof console !== "undefined" && console.log.apply(console, arguments);
}

var rootId = "";

var has = Object.prototype.hasOwnProperty;

/**
 * @param connection
 * @param local
 */
module.exports = Connection;
function Connection(connection, local, options) {
    options = options || {};
    var makeId = options.makeId || function () {
        return UUID.generate();
    };
    var locals  = LruMap(null, options.capacity || options.max || Infinity); // arrow head is local
    var remotes = LruMap(null, options.capacity || options.max || Infinity); // arrow head is remote

    var root = Q.defer();
    root.resolve(local);
    makeLocal("",root);

    connection = adapt(connection, options.origin);

    var debugKey = Math.random().toString(16).slice(2, 4).toUpperCase() + ":";
    function _debug() {
        debug.apply(null, [debugKey].concat(Array.prototype.slice.call(arguments)));
    }

    // Some day, the following will merely be:
    //  connection.forEach(function (message) {
    //      receive(message);
    //  })
    //  .then(function () {
    //      var error = new Error("Connection closed");
    //      locals.forEach(function (local) {
    //          local.reject(error);
    //      });
    //  })
    //  .done()

    // message receiver loop
    connection.get().then(get);
    function get(message) {
        _debug("receive:", message);
        connection.get().then(get);
        receive(message);
    }

    if (connection.closed) {
        connection.closed.then(function (error) {
            if (typeof error !== "object") {
                error = new Error(error);
            }
            var closedError = new Error("Connection closed because: " + error.message);
            closedError.cause = error;
            locals.forEach(function (local) {
                local.reject(closedError);
            });
        });
    }

    // message receiver
    function receive(message) {
        message = JSON.parse(message);
        _debug("receive: parsed message", message);

        if (!receivers[message.type])
            return; // ignore bad message types
        if (!hasLocal(message.to)) {
            if (typeof options.onmessagelost === "function") {
                options.onmessagelost(message);
            }
            // ignore messages to non-existant or forgotten promises
            return;
        }
        receivers[message.type](message);
    }

    // message receiver handlers by message type
    var receivers = {
        "resolve": function (message) {
            if (hasLocal(message.to)) {
                dispatchLocal(message.to, "resolve", decode(message.resolution));
            }
        },
        "notify": function (message) {
            if (hasLocal(message.to)) {
                dispatchLocal(message.to, "notify", decode(message.resolution));
            }
        },
        // a "send" message forwards messages from a remote
        // promise to a local promise.
        "send": function (message) {

            // forward the message to the local promise,
            // which will return a response promise
            var local = getLocal(message.to).promise;
            var response = local.dispatch(message.op, decode(message.args));
            //var response = local.call(message.op, decode(message.args));
            var envelope;

            // connect the local response promise with the
            // remote response promise:

            // if the value is ever resolved, send the
            // fulfilled value across the wire
            response.then(function (resolution) {
                try {
                    resolution = encode(resolution);
                } catch (exception) {
                    try {
                        resolution = {"!": encode(exception)};
                    } catch (_exception) {
                        resolution = {"!": null};
                    }
                }
                envelope = JSON.stringify({
                    "type": "resolve",
                    "to": message.from,
                    "resolution": resolution
                });
                connection.put(envelope);
            }, function (reason) {
                try {
                    reason = encode(reason);
                } catch (exception) {
                    try {
                        reason = encode(exception);
                    } catch (_exception) {
                        reason = null;
                    }
                }
                envelope = JSON.stringify({
                    "type": "resolve",
                    "to": message.from,
                    "resolution": {"!": reason}
                });
                connection.put(envelope);
            }, function (progress) {
                try {
                    progress = encode(progress);
                    envelope = JSON.stringify({
                        "type": "notify",
                        "to": message.from,
                        "resolution": progress
                    });
                } catch (exception) {
                    try {
                        progress = {"!": encode(exception)};
                    } catch (_exception) {
                        progress = {"!": null};
                    }
                    envelope = JSON.stringify({
                        "type": "resolve",
                        "to": message.from,
                        "resolution": progress
                    });
                }
                connection.put(envelope);
            })
            .done();

        }
    };

    function hasLocal(id) {
        //return id === rootId ? true : locals.has(id);
        return locals.has(id);
    }

    function getLocal(id) {
        //return id === rootId ? root : locals.get(id);
        return locals.get(id);
    }

    // construct a local promise, such that it can
    // be resolved later by a remote message
    function makeLocal(id, deferred) {
        if (hasLocal(id)) {
            return getLocal(id).promise;
        } else {
            var localDeferred = deferred || Q.defer();

            locals.set(id, localDeferred);
            return localDeferred.promise;
        }
    }

    // a utility for resolving the local promise
    // for a given identifier.
    function dispatchLocal(id, op, value) {
//        _debug(op + ':', "L" + JSON.stringify(id), JSON.stringify(value), typeof value);
        getLocal(id)[op](value);
    }

    // makes a promise that will send all of its events to a
    // remote object.
    function makeRemote(id) {
        var remotePromise = Q.makePromise({
            when: function () {
                return this;
            }
        }, function (op, args, idArgument) {
            var localIdArgument = idArgument || id;
            var localId = makeId();
            var response = makeLocal(localId);
            _debug("sending:", "R" + JSON.stringify(localIdArgument), JSON.stringify(op), JSON.stringify(encode(args)));
            connection.put(JSON.stringify({
                "type": "send",
                "to": localIdArgument,
                "from": localId,
                "op": op,
                "args": encode(args)
            }));
            return response;
        });
        remotes.set(remotePromise,id);
        return remotePromise;
    }

    // serializes an object tree, encoding promises such
    // that JSON.stringify on the result will produce
    // "QSON": serialized promise objects.
    function encode(object, memo, path ) {
        memo = memo || new Map();
        path = path || "";
        if (object === undefined) {
            return {"%": "undefined"};
        } else if (Object(object) !== object) {
            if (typeof object == "number") {
                if (object === Number.POSITIVE_INFINITY) {
                    return {"%": "+Infinity"};
                } else if (object === Number.NEGATIVE_INFINITY) {
                    return {"%": "-Infinity"};
                } else if (isNaN(object)) {
                    return {"%": "NaN"};
                }
            }
            return object;
        } else {
            var id;
            if (memo.has(object)) {
                return {"$": memo.get(object)};
            } else {
                memo.set(object, path);
            }

            if (Q.isPromise(object) || typeof object === "function") {
                if (remotes.has(object)) {
                    id = remotes.get(object);
                    // "@l" because it is local to the recieving end
                    return {"@l": id, "type": typeof object};
                } else {
                  id = makeId();
                  makeLocal(id);
                  dispatchLocal(id, "resolve", object);
                  // "@r" because it is remote to the recieving end
                  return {"@r": id, "type": typeof object};
                }
            } else if (Array.isArray(object)) {
                return object.map(function (value, index) {
                    return encode(value, memo, path + "/" + index);
                });
            } else if (
                (
                    object.constructor === Object &&
                    Object.getPrototypeOf(object) === Object.prototype
                ) ||
                object instanceof Error
            ) {
                var result = {};
                if (object instanceof Error) {
                    result.message = object.message;
                    result.stack = object.stack;
                }
                for (var key in object) {
                    if (has.call(object, key)) {
                        var newKey = key.replace(/[@!%\$\/\\]/, function ($0) {
                            return "\\" + $0;
                        });
                        result[newKey] = encode(object[key], memo, path + "/" + newKey);
                    }
                }
                return result;
            } else {
                id = makeId();
                makeLocal(id);
                dispatchLocal(id, "resolve", object);
                // "@r" because it is remote to the recieving end
                return {"@r": id, "type": typeof object};
            }
        }
    }

    // decodes QSON
    function decode(object, memo, path) {
        memo = memo || new Map();
        path = path || "";
        if (Object(object) !== object) {
            return object;
        } else if (object["$"] !== void 0) {
            return memo.get(object["$"]);
        } else if (object["%"]) {
            if (object["%"] === "undefined") {
                return undefined;
            } else if (object["%"] === "+Infinity") {
                return Number.POSITIVE_INFINITY;
            } else if (object["%"] === "-Infinity") {
                return Number.NEGATIVE_INFINITY;
            } else if (object["%"] === "NaN") {
                return Number.NaN;
            } else {
                return Q.reject(new TypeError("Unrecognized type: " + object["%"]));
            }
        } else if (object["!"]) {
            return Q.reject(object["!"]);
        } else if (object["@r"]) {
            var remote = makeRemote(object["@r"]);
            if (object.type === "function") {
                return function () {
                    return Q.fapply(remote, Array.prototype.slice.call(arguments));
                };
            } else {
                return remote;
            }
        } else if (object["@l"]) {
          return locals.get(object["@l"]);
        } else {
            var newObject = Array.isArray(object) ? [] : {};
            memo.set(path, newObject);
            for (var key in object) {
                if (has.call(object, key)) {
                    var newKey = key.replace(/\\([\\!@%\$\/])/, function ($0, $1) {
                        return $1;
                    });
                    newObject[newKey] = decode(object[key], memo, path + "/" + key);
                }
            }
            return newObject;
        }
    }

    // a peer-to-peer promise connection is symmetric: both
    // the local and remote side have a "root" promise
    // object. On each side, the respective remote object is
    // returned, and the object passed as an argument to
    // Connection is used as the local object.  The identifier of
    // the root object is an empty-string by convention.
    // All other identifiers are numbers.
    return makeRemote(rootId);

}

