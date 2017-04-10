'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var ERROR_HOST_REQUIRED = 'Either host or configUrl is a required option.';

var Vision = function () {
  function Vision(options) {
    _classCallCheck(this, Vision);

    this.options = options || {};

    this.websocket = {};

    this.uri = '';

    this.connectionRetryMax = 0; // 0 = unlimited retries

    this.connectionRetryIntervalMax = 10 * 1000; // maximum number of milliseconds to delay a retry attempt.

    this.connectionRetryCount = 0;

    this.connectionRetryInterval = 1000;

    this.monitorInfo = {};

    this.hostInfo = {};

    this.processList = {};

    this.additionalProps = options.additionalProps || {};

    this.clientComputerName = '';

    this.sentScreenshot = false;

    this.lastScreenshot = 0;

    this.minimumSecondsBetweenScreenshots = options.minimumSecondsBetweenScreenshots || 120;

    this.notifyLastActionScreenshotDelay = options.notifyLastActionScreenshotDelay || 500;

    this.fullDataPacketEvery = 30; // send the full heartbeat every (default 30) heartbeats (starts off with full).

    this.additionalDataCollector = options.additionalDataCollector || function () {
      return {};
    };

    this.actions = options.actions || {};

    this.heartbeatCount = 0;

    this.heartbeatInterval = options.heartbeatInterval > 1000 ? options.heartbeatInterval : 10 * 1000;

    this.init(this.options);
  }

  _createClass(Vision, [{
    key: 'debug',
    value: function debug(message) {
      if (this.options.debug) {
        for (var _len = arguments.length, args = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
          args[_key - 1] = arguments[_key];
        }

        console.log(message, args);
      }
    }
  }, {
    key: 'init',
    value: function init(options) {
      var _this = this;

      if (!options || !options.host && !options.configUrl) {
        this.debug(ERROR_HOST_REQUIRED);
        throw new Error(ERROR_HOST_REQUIRED);
      }

      if (options.configUrl) {
        fetch(options.configUrl).then(function (response) {
          return response.json();
        }).then(function (config) {
          if (Array.isArray(config)) {
            config = config[0];
          }

          Object.assign(_this.options, options, config);

          return _this.setupSocket();
        });
      } else {
        this.setupSocket();
      }
    }
  }, {
    key: 'setupSocket',
    value: function setupSocket() {
      var host = this.options.host,
          port = this.options.port || 16999,
          path = this.options.path || '/';

      this.uri = 'ws://' + host + ':' + port + path;

      this.debug('connecting to uri: ' + this.uri);

      if (document && document.addEventListener) {
        var self = this;

        if (document.readyState === 'complete' || document.readyState === 'interactive') {
          this.configureFin();
        } else {
          document.addEventListener('DOMContentLoaded', function () {
            self.configureFin();
          });
        }
      }
    }
  }, {
    key: 'configureFin',
    value: function configureFin() {
      this.debug('Configure FIN...');
      var self = this;
      if (window && window.fin && fin.desktop) {
        fin.desktop.main(function () {
          self.connect();

          fin.desktop.System.getEnvironmentVariable('HOSTNAME', function (value) {
            if (value) {
              self.clientComputerName = value;
            }
          }, function (err) {
            self.debug('ERROR getting env variable:', err);
          });
        });
      } else {
        self.debug('openfin environment not found. Not connecting to vision server.');
        return;
      }

      // TODO: Move to a function.  Also move to a more appropriate place.  Also look into race condition with w.vision.connect();
      fin.desktop.System.getMonitorInfo(function (monitorInfo) {
        self.monitorInfo = monitorInfo;
      });

      fin.desktop.System.getHostSpecs(function (hostInfo) {
        self.hostInfo = hostInfo;
      });

      fin.desktop.System.getProcessList(function (processList) {
        self.processList = processList;
      });
    }
  }, {
    key: 'heartbeat',
    value: function heartbeat(socket) {
      var self = this;
      setTimeout(function () {
        var heartbeatMessage = {
          type: 'heartbeat'
        };

        if (self.heartbeatCount === 0 || self.heartbeatCount % self.fullDataPacketEvery === 0) {
          heartbeatMessage = Object.assign({}, heartbeatMessage, {
            location: window.location,
            connectionId: self.connectionId,
            processList: self.processList,
            hostInfo: self.hostInfo,
            monitorInfo: self.monitorInfo,
            additionalProps: self.additionalProps
          }, { additionalData: self.additionalDataCollector() });
        }

        if (socket.readyState === 1) {
          self.heartbeatCount++;

          self.debug('sending hb# ' + self.heartbeatCount, heartbeatMessage);

          socket.send(JSON.stringify(heartbeatMessage));

          self.heartbeat(socket);

          if (!self.sentScreenshot) {
            self.sentScreenshot = true;
            self.takeScreenshot();
          }
        }

        if (socket.readyState > 1) self.handleConnectionError();
      }, self.heartbeatInterval || 10000);
    }
  }, {
    key: 'messageHandler',
    value: function messageHandler(event) {
      if (!event || !event.data) return;

      var self = this;
      this.debug('message: ', event.data);
      var message = JSON.parse(event.data);

      if (message.type === 'handshake') {
        this.connectionId = message.connectionId;
      } else if (message.type === 'shutdown') {
        window.close();
      } else if (message.type === 'restart') {
        fin.desktop.Application.getCurrent().restart();
      } else if (message.type === 'take-screenshot') {
        this.takeScreenshot();
      } else {
        if (this.options.actions[message.type]) {
          var fn = this.options.actions[message.type].bind(this);
          var result = fn(message);
          if ((typeof result === 'undefined' ? 'undefined' : _typeof(result)) === 'object' && result.then) {
            result.then(function (r) {
              if (self.websocket.readyState === 1) {
                self.websocket.send(JSON.stringify({
                  type: '' + message.type,
                  data: r
                }));
              }
            }).catch(function (err) {
              console.error('vision-openfin - Failed executing client action:', err);
            });
          } else {
            if (self.websocket.readyState === 1) {
              self.websocket.send(JSON.stringify({
                type: '' + message.type,
                data: result
              }));
            }
          }
        }
      }
    }
  }, {
    key: 'connect',
    value: function connect(uri) {
      var _this2 = this;

      var wsUri = uri || this.uri,
          self = this;

      this.websocket = new WebSocket(wsUri);
      this.websocket.onerror = function (event) {
        _this2.debug('socket failed. attempting reconnect.');
        return _this2.handleConnectionError(uri);
      };

      if (!this.websocket.onopen) {
        this.websocket.onopen = function (evnt) {
          _this2.debug('onopen - event:' + JSON.stringify(evnt));
          _this2.connectionRetryCount = 0;
          _this2.connectionRetryInterval = 1000;
          _this2.heartbeat.bind(self, _this2.websocket)();
        };
      }

      if (!this.websocket.onmessage) {
        this.websocket.onmessage = this.messageHandler.bind(this);
      }
    }
  }, {
    key: 'handleConnectionError',
    value: function handleConnectionError(uri) {
      var _this3 = this;

      this.debug('Failed connecting to vision server: ' + uri + ', retrying with back-off.');

      this.connectionRetryCount++;

      if (this.connectionRetryMax > 0 && this.connectionRetryMax > this.connectionRetryCount) {
        this.debug('Connection retries exhausted. Max: ' + this.connectionRetryMax);
        return;
      }

      this.connectionRetryInterval = Math.pow(2, this.connectionRetryCount) * 1000;

      if (this.connectionRetryInterval > this.connectionRetryIntervalMax) {
        this.connectionRetryInterval = this.connectionRetryIntervalMax;
      }

      setTimeout(function () {
        return _this3.connect(uri);
      }, this.connectionRetryInterval);
      this.debug('Retrying connection to server in ' + this.connectionRetryInterval / 1000 + ' seconds.');
    }
  }, {
    key: 'notifyLastAction',
    value: function notifyLastAction(action) {
      this.debug('notifying of action: ' + action);

      if (this.websocket.readyState === 1) {
        this.websocket.send(JSON.stringify({
          type: 'user-action',
          action: action
        }));
      }

      if (action && action.takeScreenshot) {
        setTimeout(this.takeScreenshot.bind(this), this.notifyLastActionScreenshotDelay);
      }
    }
  }, {
    key: 'updateAdditionalProps',
    value: function updateAdditionalProps(dataToMerge) {
      this.additionalProps = Object.assign(this.additionalProps, dataToMerge);
    }
  }, {
    key: 'takeScreenshot',
    value: function takeScreenshot() {
      this.debug('takeScreenshot called.');
      var secondsSinceLastScreenshot = (Date.now() - this.lastScreenshot) / 1000;

      if (secondsSinceLastScreenshot < this.minimumSecondsBetweenScreenshots) {
        this.debug('screenshot skipped, last one taken ' + secondsSinceLastScreenshot + ' seconds ago.');
        return;
      }

      this.lastScreenshot = Date.now();

      var finWindow = fin.desktop.Window.getCurrent(),
          self = this;
      finWindow.getSnapshot(function (base64Snapshot) {
        if (self.websocket.readyState === 1) {
          self.websocket.send(JSON.stringify({
            type: 'screenshot',
            data: base64Snapshot
          }));
        }
      });
    }
  }]);

  return Vision;
}();

module.exports = Vision;