import { Event } from './event';

export function Websocket(url) {
  this._conn = new WebSocket(url);
  this._conn.binaryType = "arraybuffer";
  this._conn.addEventListener('open', this._onOpen.bind(this));
  this._conn.addEventListener('message', this._onMessage.bind(this));
  this._conn.addEventListener('error', this._onError.bind(this));
  this._conn.addEventListener('close', this._onClose.bind(this));
};

Event.mixin(Websocket.prototype);

Websocket.prototype._onOpen = function(e) {
  this.dispatchEvent(new CustomEvent('open'));
};

Websocket.prototype._onMessage = function(e) {
  var data = new Uint8Array(e.data);
  this.dispatchEvent(new CustomEvent('data', {
    detail: {
      data: String.fromCharCode.apply(String, data)
    }
  }));
};

Websocket.prototype._onError = function(e) {
  this.dispatchEvent(new CustomEvent('error'));
};

Websocket.prototype._onClose = function(e) {
  this.dispatchEvent(new CustomEvent('close'));
};

Websocket.prototype.send = function(str) {
  // 分塊送：ptt 在一次收到大量貼上的文字後回應會變慢，切小塊比較穩。
  // 這是 wire 層的限制，所以**就該待在 socket 層**（每個送出端都會經過這裡），
  // 不要往上搬到 app。
  var chunk = 1000;
  for (var i = 0; i < str.length; i += chunk) {
    var chunkStr = str.substring(i, i+chunk);
    var byteArray = new Uint8Array(chunkStr.split('').map(function(x) { return x.charCodeAt(0); }));
    this._conn.send(byteArray.buffer);
  }
};

Websocket.prototype.close = function() {
  this._conn.close();
};
