
class BaseDeviceController {
    constructor(device) {
        this.device = device;
        this.gattServer = null;
        this.isConnected = false;
        this.characteristics = {};
    }

    async connect() {
        if (this.isConnected) {
            console.log('Device is already connected.');
            return;
        }

        try {
            console.log(`Connecting to device: ${this.device.name}`);
            this.gattServer = await this.device.gatt.connect();
            this.isConnected = true;
            console.log(`Connected to device: ${this.device.name}`);
        } catch (error) {
            console.error(`Error connecting to device: ${error}`);
            throw error;
        }
    }

    async disconnect() {
        if (!this.isConnected) {
            console.log('Device is not connected.');
            return;
        }

        try {
            await this.device.gatt.disconnect();
            this.isConnected = false;
            this.gattServer = null;
            this.characteristics = {};
            console.log(`Disconnected from device: ${this.device.name}`);
        } catch (error) {
            console.error(`Error disconnecting from device: ${error}`);
            throw error;
        }
    }

    async getService(serviceUUID) {
        if (!this.isConnected) {
            throw new Error('Device is not connected.');
        }

        try {
            return await this.gattServer.getPrimaryService(serviceUUID);
        } catch (error) {
            console.error(`Error getting service ${serviceUUID}: ${error}`);
            throw error;
        }
    }

    async getCharacteristic(service, characteristicUUID, characteristicKey) {
        try {
            const characteristic = await service.getCharacteristic(characteristicUUID);
            this.characteristics[characteristicKey] = characteristic;
            return characteristic;
        } catch (error) {
            console.error(`Error getting characteristic ${characteristicUUID}: ${error}`);
            throw error;
        }
    }

    async startNotifications(characteristicKey, callback = null) {
        if (!this.characteristics[characteristicKey]) {
            throw new Error(`Characteristic ${characteristicKey} is not available`);
        }

        try {
            await this.characteristics[characteristicKey].startNotifications();
            this.characteristics[characteristicKey].addEventListener('characteristicvaluechanged', (event) => {
                const value = event.target.value;
                this.handleNotification(characteristicKey, value);
                if (callback) callback(value);
            });
            console.log(`Started notifications for ${characteristicKey}`);
        } catch (error) {
            console.error(`Error starting ${characteristicKey} notifications:`, error);
            throw error;
        }
    }

    async stopNotifications(characteristicKey) {
        if (!this.characteristics[characteristicKey]) {
            throw new Error(`Characteristic ${characteristicKey} is not available`);
        }

        try {
            await this.characteristics[characteristicKey].stopNotifications();
        } catch (error) {
            console.error(`Error stopping ${characteristicKey} notifications:`, error);
            throw error;
        }
    }

    handleNotification(characteristicKey, value) {
        // Implementation in derived classes
    }
}

class ToioController extends BaseDeviceController {
    static TOIO_SERVICE_UUID = '10b20100-5b3b-4571-9508-cf3efcd7bbae';
    static POSITION_CHARACTERISTIC_UUID = '10b20101-5b3b-4571-9508-cf3efcd7bbae';

    constructor(device, onPositionMissed) {
        super(device);
        this.onPositionMissed = onPositionMissed;
    }

    async connect() {
        await super.connect();
        const service = await this.getService(ToioController.TOIO_SERVICE_UUID);
        await this.getCharacteristic(service, ToioController.POSITION_CHARACTERISTIC_UUID, 'position');
    }

    async startPositionNotifications(callback) {
        await this.startNotifications('position', (value) => {
            const position = this.parsePositionData(value);
            if (position) {
                callback(position);
            } else {
                this.onPositionMissed();
            }
        });
    }

    parsePositionData(value) {
        if (value.byteLength >= 6) {
            const data = new DataView(value.buffer);
            const x = data.getUint16(1, true);
            const y = data.getUint16(3, true);
            const angle = data.getUint16(5, true);
            return { x, y, angle };
        }
        return null;
    }
}

class DeviceManager {
    constructor() {
        this.devices = new Map();
        this.positionListeners = new Map();
    }

    async handleConnect() {
        try {
            console.log("Requesting Bluetooth Device...");
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [ToioController.TOIO_SERVICE_UUID] }]
            });

            const controller = new ToioController(device, () => { });
            await controller.connect();
            this.devices.set(device.id, controller);

            await controller.startPositionNotifications((position) => {
                this.notifyPositionListeners(device.id, position);
            });

            return controller;
        } catch (error) {
            console.error('Error connecting to device:', error);
            throw error;
        }
    }

    async handleDisconnect() {
        try {
            for (const [id, controller] of this.devices) {
                await controller.disconnect();
            }
            this.devices.clear();
            this.positionListeners.clear();
        } catch (error) {
            console.error('Error disconnecting devices:', error);
            throw error;
        }
    }

    getDevice(deviceId) {
        return this.devices.get(deviceId);
    }

    getAllDevices() {
        return Array.from(this.devices.values());
    }

    addPositionListener(deviceId, listenerFunction) {
        if (!this.positionListeners.has(deviceId)) {
            this.positionListeners.set(deviceId, new Set());
        }
        this.positionListeners.get(deviceId).add(listenerFunction);
    }

    removePositionListener(deviceId, listenerFunction) {
        if (this.positionListeners.has(deviceId)) {
            this.positionListeners.get(deviceId).delete(listenerFunction);
        }
    }

    notifyPositionListeners(deviceId, position) {
        if (this.positionListeners.has(deviceId)) {
            this.positionListeners.get(deviceId).forEach(listener => listener(position));
        }
    }
}

class SamplingRateMeasurer {
    constructor(deviceManager) {
        this.deviceManager = deviceManager;
        this.samples = [];
        this.isMessuring = false;
    }

    async measureSamplingRate(deviceId, duration = 5000) {
        const device = this.deviceManager.getDevice(deviceId);
        if (!device) {
            throw new Error('Device not found');
        }

        this.samples = [];
        this.isMessuring = true;

        const listener = (position) => {
            if (this.isMessuring) {
                this.samples.push({
                    timestamp: performance.now(),
                    ...position
                });
            }
        };
        this.deviceManager.addPositionListener(deviceId, listener);

        await new Promise(resolve => setTimeout(resolve, duration));

        this.isMessuring = false;
        this.deviceManager.removePositionListener(deviceId, listener);

        return this.calculateResults();
    }

    calculateResults() {
        if (this.samples.length < 2) {
            return {
                samplingRate: 0,
                avgSamplingPeriod: 0,
                totalTime: 0,
                sampleCount: 0
            };
        }

        const totalTime = this.samples[this.samples.length - 1].timestamp - this.samples[0].timestamp;
        const avgSamplingPeriod = totalTime / (this.samples.length - 1);
        const samplingRate = 1000 / avgSamplingPeriod;

        return {
            samplingRate,
            avgSamplingPeriod,
            totalTime,
            sampleCount: this.samples.length
        };
    }

    exportToCsv() {
        if (this.samples.length === 0) {
            throw new Error('No data to export');
        }

        const headers = ['timestamp', 'x', 'y', 'angle', 'delta_time'];
        const csvRows = [headers.join(',')];

        this.samples.forEach((sample, index) => {
            const deltaTime = index === 0 ? 0 :
                sample.timestamp - this.samples[index - 1].timestamp;

            const row = [
                sample.timestamp.toFixed(2),
                sample.x,
                sample.y,
                sample.angle,
                deltaTime.toFixed(2)
            ];
            csvRows.push(row.join(','));
        });

        return csvRows.join('\n');
    }

    downloadCsv(filename = 'toio-sampling-data.csv') {
        const csvContent = this.exportToCsv();
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

// UI Controller
class UIController {
    constructor() {
        this.deviceManager = new DeviceManager();
        this.currentMeasurer = null;
        this.measurementCount = 0;
        this.measurements = [];

        this.initializeElements();
        this.attachEventListeners();
    }

    initializeElements() {
        this.connectButton = document.getElementById('connectButton');
        this.measureButton = document.getElementById('measureButton');
        this.exportButton = document.getElementById('exportButton');
        this.statusElement = document.getElementById('status');
        this.resultTable = document.getElementById('resultTable').getElementsByTagName('tbody')[0];
        this.durationInput = document.getElementById('duration');
        this.avgRateElement = document.getElementById('avgRate');
        this.stdDevElement = document.getElementById('stdDev');
        this.measureCountElement = document.getElementById('measureCount');
    }

    attachEventListeners() {
        this.connectButton.addEventListener('click', () => this.handleConnectClick());
        this.measureButton.addEventListener('click', () => this.handleMeasureClick());
        this.exportButton.addEventListener('click', () => this.handleExportClick());
    }

    async handleConnectClick() {
        if (this.deviceManager.getAllDevices().length === 0) {
            try {
                await this.deviceManager.handleConnect();
                this.connectButton.textContent = 'toioを切断';
                this.connectButton.classList.add('connected');
                this.measureButton.disabled = false;
                this.showStatus('toioに接続しました', 'success');
            } catch (error) {
                this.showStatus('接続エラー: ' + error.message, 'error');
            }
        } else {
            try {
                await this.deviceManager.handleDisconnect();
                this.connectButton.textContent = 'toioに接続';
                this.connectButton.classList.remove('connected');
                this.measureButton.disabled = true;
                this.exportButton.disabled = true;
                this.showStatus('toioから切断しました', 'success');
            } catch (error) {
                this.showStatus('切断エラー: ' + error.message, 'error');
            }
        }
    }

    async handleMeasureClick() {
        const duration = parseInt(this.durationInput.value);
        if (isNaN(duration) || duration < 1000) {
            this.showStatus('測定時間は1000ms以上を指定してください', 'error');
            return;
        }

        try {
            this.measureButton.disabled = true;
            this.showStatus('測定中...', 'success');

            const devices = this.deviceManager.getAllDevices();
            if (devices.length === 0) {
                throw new Error('接続されたデバイスがありません');
            }

            const deviceId = devices[0].device.id;
            this.currentMeasurer = new SamplingRateMeasurer(this.deviceManager);
            const results = await this.currentMeasurer.measureSamplingRate(deviceId, duration);

            this.measurementCount++;
            this.measurements.push(results);
            this.updateResults();

            this.measureButton.disabled = false;
            this.exportButton.disabled = false;
            this.showStatus('測定完了', 'success');
        } catch (error) {
            this.showStatus('測定エラー: ' + error.message, 'error');
            this.measureButton.disabled = false;
        }
    }

    handleExportClick() {
        if (this.currentMeasurer) {
            try {
                this.currentMeasurer.downloadCsv();
                this.showStatus('CSVファイルをダウンロードしました', 'success');
            } catch (error) {
                this.showStatus('エクスポートエラー: ' + error.message, 'error');
            }
        }
    }

    updateResults() {
        // Add new row to table
        const result = this.measurements[this.measurements.length - 1];
        const row = this.resultTable.insertRow();
        row.insertCell().textContent = this.measurementCount;
        row.insertCell().textContent = result.sampleCount;
        row.insertCell().textContent = result.totalTime.toFixed(2);
        row.insertCell().textContent = result.avgSamplingPeriod.toFixed(2);
        row.insertCell().textContent = result.samplingRate.toFixed(2);

        // Update statistics
        const rates = this.measurements.map(m => m.samplingRate);
        const avgRate = rates.reduce((a, b) => a + b) / rates.length;
        const stdDev = Math.sqrt(
            rates.map(x => Math.pow(x - avgRate, 2))
                .reduce((a, b) => a + b) / rates.length
        );

        this.avgRateElement.textContent = avgRate.toFixed(2) + ' Hz';
        this.stdDevElement.textContent = stdDev.toFixed(2) + ' Hz';
        this.measureCountElement.textContent = this.measurementCount;
    }

    showStatus(message, type) {
        this.statusElement.textContent = message;
        this.statusElement.className = type;
        this.statusElement.style.display = 'block';
    }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    window.uiController = new UIController();
});