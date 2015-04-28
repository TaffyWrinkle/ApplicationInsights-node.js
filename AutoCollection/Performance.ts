///<reference path='..\Declarations\node\node.d.ts' />

import http = require("http");
import os = require("os");

import Client = require("../Library/Client");
import Logging = require("../Library/Logging");

class AutoCollectPerformance {

    private static _totalRequestCount: number = 0;
    private static _totalFailedRequestCount: number = 0;

    private static _INSTANCE: AutoCollectPerformance = null;

    private _client: Client;
    private _handle: NodeJS.Timer;
    private _isEnabled: boolean;
    private _isInitialized: boolean;
    private _lastCpus: { model: string; speed: number; times: { user: number; nice: number; sys: number; idle: number; irq: number; }; }[];
    private _lastRequests: { totalRequestCount: number; totalFailedRequestCount: number; time: number };

    constructor(client: Client) {
        if(AutoCollectPerformance._INSTANCE !== null) {
            throw new Error("Exception tracking should be configured from the ApplicationInsights object");
        }

        this._client = client;
    }

    public enable(isEnabled: boolean) {
        this._isEnabled = isEnabled;
        if(this._isEnabled && !this._isInitialized) {
            this._initialize();
        }

        if(isEnabled) {
            if(!this._handle) {
                this._lastCpus = os.cpus();
                this._lastRequests = {
                    totalRequestCount: AutoCollectPerformance._totalRequestCount,
                    totalFailedRequestCount: AutoCollectPerformance._totalFailedRequestCount,
                    time: +new Date
                };

                this._handle = setInterval(() => this.trackPerformance(), 10000);
            }
        } else {
            if(this._handle) {
                clearInterval(this._handle);
                this._handle = undefined;
            }
        }
    }

    private _initialize() {
        var originalServer = http.createServer;
        http.createServer = (onRequest) => {
            return originalServer((request:http.ServerRequest, response:http.ServerResponse) => {
                if (this._isEnabled) {
                    AutoCollectPerformance.countRequest(request, response);
                }

                if (typeof onRequest === "function") {
                    onRequest(request, response);
                }
            });
        }
    }

    public static countRequest(request:http.ServerRequest, response:http.ServerResponse) {
        if (!request || !response) {
            Logging.warn("AutoCollectPerformance.countRequest was called with invalid parameters: ", !!request, !!response);
            return;
        }

        // response listeners
        if (typeof response.once === "function") {
            response.once('finish', () => {
                AutoCollectPerformance._totalRequestCount++;
                if(response.statusCode >= 400) {
                    AutoCollectPerformance._totalFailedRequestCount++;
                }
            });
        }
    }

    public trackPerformance() {
        this._trackCpu();
        this._trackMemory();
        this._trackNetwork();
    }

    private _trackCpu() {
        // this reports total ms spent in each category since the OS was booted, to calculate percent it is necessary
        // to find the delta since the last measurement
        var cpus = os.cpus();
        if(cpus && cpus.length && this._lastCpus && cpus.length === this._lastCpus.length) {
            var totalUser = 0;
            var totalSys = 0;
            var totalNice = 0;
            var totalIdle = 0;
            var totalIrq = 0;
            for(var i = 0; !!cpus && i < cpus.length; i++) {
                var cpu = cpus[i];
                var lastCpu = this._lastCpus[i];

                var name = "% cpu[" + i + "] ";
                var model = cpu.model;
                var speed = cpu.speed;
                var times = cpu.times;
                var lastTimes = lastCpu.times;

                // user cpu time (or) % CPU time spent in user space
                var user = (times.user - lastTimes.user) || 0;
                totalUser += user;

                // system cpu time (or) % CPU time spent in kernel space
                var sys = (times.sys - lastTimes.sys) || 0;
                totalSys += sys;

                // user nice cpu time (or) % CPU time spent on low priority processes
                var nice = (times.nice - lastTimes.nice) || 0;
                totalNice += nice;

                // idle cpu time (or) % CPU time spent idle
                var idle = (times.idle - lastTimes.idle) || 0;
                totalIdle += idle;

                // irq (or) % CPU time spent servicing/handling hardware interrupts
                var irq = (times.irq - lastTimes.irq) || 0;
                totalIrq += irq;

                var total = (user + sys + nice + idle + irq) || 1; // don't let this be 0 since it is a divisor

                //this._client.trackMetric(name + "user", user / total);
                //this._client.trackMetric(name + "sys", sys / total);
                //this._client.trackMetric(name + "nice", nice / total);
                //this._client.trackMetric(name + "idle", idle / total);
                //this._client.trackMetric(name + "irq", irq / total);

                this._client.trackMetric(name + "user", user / total);
            }

            var combinedName = "% total cpu ";
            var combinedTotal = (totalUser + totalSys + totalNice + totalIdle + totalIrq) || 1;

            this._client.trackMetric(combinedName + "user", totalUser / combinedTotal);
            this._client.trackMetric(combinedName + "sys", totalSys / combinedTotal);
            this._client.trackMetric(combinedName + "nice", totalNice / combinedTotal);
            this._client.trackMetric(combinedName + "idle", totalIdle / combinedTotal);
            this._client.trackMetric(combinedName + "irq", totalIrq/ combinedTotal);
        }
        
        this._lastCpus = cpus;
    }

    private _trackMemory() {
        var totalMem = os.totalmem();
        var freeMem = os.freemem();
        var usedMem = totalMem - freeMem;
        var percentUsedMem = usedMem / (totalMem || 1);
        var percentAvailableMem = freeMem / (totalMem || 1);
        this._client.trackMetric("Memory Used", usedMem);
        this._client.trackMetric("Memory Free", freeMem);
        this._client.trackMetric("Memory Total", totalMem);
        this._client.trackMetric("% Memory Used", percentUsedMem);
        this._client.trackMetric("% Memory Free", percentAvailableMem);
    }

    private _trackNetwork() {
        // track total request counters
        var lastRequests = this._lastRequests;
        var requests = {
            totalRequestCount: AutoCollectPerformance._totalRequestCount,
            totalFailedRequestCount: AutoCollectPerformance._totalFailedRequestCount,
            time: +new Date
        };

        var intervalRequests = (requests.totalRequestCount - lastRequests.totalRequestCount) || 0;
        var intervalFailedRequests = (requests.totalFailedRequestCount - lastRequests.totalFailedRequestCount) || 0;
        var elapsedMs = requests.time - lastRequests.time;
        var elapsedSeconds = elapsedMs / 1000;

        if(elapsedMs > 0) {
            var requestsPerSec = intervalRequests / elapsedSeconds;
            var failedRequestsPerSec = intervalFailedRequests / elapsedSeconds;

            this._client.trackMetric("Total Requests", requests.totalRequestCount);
            this._client.trackMetric("Total Failed Requests", requests.totalFailedRequestCount);
            this._client.trackMetric("Requests per Second", requestsPerSec);
            this._client.trackMetric("Failed Requests per Second", failedRequestsPerSec);
        }

        this._lastRequests = requests;
    }
}

export = AutoCollectPerformance;