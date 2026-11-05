// Cloudflare Worker 進入點：把 Cloudflare 專屬 API 注入 relay.js（純邏輯、主 repo unit 測得到）。
import { connect } from 'cloudflare:sockets';
import { handleRequest } from './relay.js';

export default {
  fetch(request, env) {
    return handleRequest(request, env, { connect, WebSocketPair });
  },
};
