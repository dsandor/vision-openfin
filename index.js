'use strict';

const ERROR_HOST_REQUIRED = 'Either host or configUrl is a required option.';

class Vision {
  constructor(options) {
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

    this.additionalDataCollector = options.additionalDataCollector || function() { return {} };

    this.heartbeatCount = 0;

    this.init(this.options);
  }

  debug(message, ...args) {
    if (this.options.debug) {
      console.log(message, args);
    }
  }

  init(options) {
    if (!options || (!options.host && !options.configUrl)) {
      this.debug(ERROR_HOST_REQUIRED);
      throw new Error(ERROR_HOST_REQUIRED);
    }

    if (options.configUrl) {
      fetch(options.configUrl)
        .then((response) => response.json())
        .then((config) => {
          if (Array.isArray(config)) {
            config = config[0];
          }

          Object.assign(this.options, options, config);

          return this.setupSocket();
        });
    } else {
      this.setupSocket();
    }
  }

  setupSocket() {
    let host = this.options.host,
      port = this.options.port || 16999,
      path = this.options.path || '/';

    this.uri = `ws://${host}:${port}${path}`;

    this.debug(`connecting to uri: ${this.uri}`);

    if (document && document.addEventListener) {
      let self = this;

      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        this.configureFin();
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          self.configureFin();
        });
      }
    }
  }

  configureFin() {
    this.debug('Configure FIN...');
    let self = this;
    if (window && window.fin && fin.desktop) {
      fin.desktop.main(function () {
        self.connect();

        fin.desktop.System.getEnvironmentVariable('HOSTNAME', function (value) {
          if (value) {
            self.clientComputerName = value;
          }
        }, (err) => {
          self.debug('ERROR getting env variable:', err);
        });
      });
    } else {
      self.debug('openfin environment not found. Not connecting to vision server.');
      return;
    }

    // TODO: Move to a function.  Also move to a more appropriate place.  Also look into race condition with w.vision.connect();
    fin.desktop.System.getMonitorInfo((monitorInfo) => {
      self.monitorInfo = monitorInfo;
    });

    fin.desktop.System.getHostSpecs((hostInfo) => {
      self.hostInfo = hostInfo;
    });

    fin.desktop.System.getProcessList((processList) => {
      self.processList = processList;
    });
  }

  heartbeat(socket) {
    setTimeout(() => {
      let heartbeatMessage = {
        type: 'heartbeat'
      };

      if (this.heartbeatCount === 0 || (this.heartbeatCount % this.fullDataPacketEvery === 0)) {
        heartbeatMessage = Object.assign({}, 
          {
            location: window.location,
            connectionId: this.connectionId,
            processList: this.processList,
            hostInfo: this.hostInfo,
            monitorInfo: this.monitorInfo,
            additionalProps: this.additionalProps
          },
          { additionalData: this.additionalDataCollector() });
      }

      if (socket.readyState === 1) {
        this.heartbeatCount++;
        
        socket.send(JSON.stringify(heartbeatMessage));

        this.heartbeat(socket);

        if (!this.sentScreenshot) {
          this.sentScreenshot = true;
          this.takeScreenshot();
        }
      }

      if (socket.readyState > 1) this.handleConnectionError();
    }, this.options.heartbeatInterval || 1000);
  }

  messageHandler(event) {
    if (!event || !event.data) return;

    this.debug('message: ', event.data);
    let message = JSON.parse(event.data);

    if (message.type === 'handshake') {
      this.connectionId = message.connectionId;
    } else if (message.type === 'shutdown') {
      window.close();
    } else if (message.type === 'restart') {
      fin.desktop
        .Application
        .getCurrent()
        .restart();
    } else if (message.type === 'take-screenshot') {
      this.takeScreenshot();
    }

  }

  connect(uri) {
    var wsUri = uri || this.uri;

    this.websocket = new WebSocket(wsUri);
    this.websocket.onerror = (event) => {
      this.debug('socket failed. attempting reconnect.');
      return this.handleConnectionError(uri);
    }

    if (!this.websocket.onopen) {
      this.websocket.onopen = (evnt) => {
        this.debug('onopen - event:' + JSON.stringify(evnt));
        this.connectionRetryCount = 0;
        this.connectionRetryInterval = 1000;
        this.heartbeat(this.websocket);
      };
    }

    if (!this.websocket.onmessage) {
      this.websocket.onmessage = this.messageHandler.bind(this);
    }
  }

  handleConnectionError(uri) {
    this.debug(`Failed connecting to vision server: ${uri}, retrying with back-off.`);

    this.connectionRetryCount++;

    if (this.connectionRetryMax > 0 && this.connectionRetryMax > this.connectionRetryCount) {
      this.debug(`Connection retries exhausted. Max: ${this.connectionRetryMax}`);
      return;
    }

    this.connectionRetryInterval = Math.pow(2, this.connectionRetryCount) * 1000;

    if (this.connectionRetryInterval > this.connectionRetryIntervalMax) {
      this.connectionRetryInterval = this.connectionRetryIntervalMax;
    }

    setTimeout(() => this.connect(uri), this.connectionRetryInterval);
    this.debug(`Retrying connection to server in ${this.connectionRetryInterval / 1000} seconds.`);
  }

  notifyLastAction(action) {
    this.debug(`notifying of action: ${action}`);

    if (this.websocket.readyState === 1) {
      this.websocket.send(JSON.stringify({
        type: 'user-action',
        action
      }));
    }

    if (action && action.takeScreenshot) {
      setTimeout(this.takeScreenshot.bind(this), this.notifyLastActionScreenshotDelay);
    }
  }

  updateAdditionalProps(dataToMerge) {
    this.additionalProps = Object.assign(this.additionalProps, dataToMerge);
  }

  takeScreenshot() {
    this.debug('takeScreenshot called.');
    let secondsSinceLastScreenshot = (Date.now() - this.lastScreenshot) / 1000;

    if (secondsSinceLastScreenshot < this.minimumSecondsBetweenScreenshots) {
      this.debug(`screenshot skipped, last one taken ${secondsSinceLastScreenshot} seconds ago.`);
      return;
    }

    this.lastScreenshot = Date.now();

    let finWindow = fin.desktop.Window.getCurrent(),
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
}

module.exports = Vision;
