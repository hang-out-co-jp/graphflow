#!/usr/bin/env node
/**
 * plugins/graphflow/web/index.html を Artifact 用に変換する。
 *
 * Artifact は <!doctype><head></head><body> の器を後から被せるので、
 * こちら側からは <title> / <style> / 本文 だけを渡す。
 * 真実源は index.html ただ1つ。こちらは生成物なので手で直さない。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "plugins", "graphflow", "web", "index.html");
const OUT = path.join(__dirname, "dist", "graphflow-artifact.html");

const html = fs.readFileSync(SRC, "utf8");

const pick = (re, what) => {
  const m = html.match(re);
  if (!m) { console.error(`${what} が見つかりません`); process.exit(1); }
  return m[1];
};

const title = pick(/<title>([\s\S]*?)<\/title>/, "<title>");
const style = pick(/<style>([\s\S]*?)<\/style>/, "<style>");
const body = pick(/<body>([\s\S]*?)<\/body>/, "<body>");

const out = `<title>${title}</title>
<style>
${style.trim()}
</style>
${body.trim()}
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out, "utf8");
console.log(`${path.relative(__dirname, OUT)} (${out.length.toLocaleString()} バイト)`);
