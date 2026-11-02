/**
 * 部署配置
 * 部署完成后，把 API_BASE 改成你的 Cloudflare Worker 地址（结尾不要带斜杠）。
 * 例如: "https://voice-aura-api.xxx.workers.dev"
 * 说明:
 *  - 在 GitHub Pages 上必须配置 API_BASE，否则无法调用 AI 分析接口；
 *  - 在 Cloudflare Worker 自带站点（wrangler dev / workers.dev）上留空即可（同源直连）。
 */
window.APP_CONFIG = {
  API_BASE: "https://voice-aura-api.peach-blossom-fortune.workers.dev",
};
