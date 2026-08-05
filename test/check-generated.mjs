#!/usr/bin/env node
/**
 * 書き出したワークフローが、図面の言っているとおりになっているかを機械で確かめる。
 *
 *   node test/check-generated.mjs <図面.graphflow.json> <ワークフロー.js> [...]
 *
 * 何度も踏んだ失敗が「図が嘘をつく」型だった。
 *   ・図は「同時に8本」と言うのに、コードは 4→3→1 と順番に走っていた
 *   ・図は「上限60体」と言うのに、コードには止める経路が1本も無かった
 *   ・偽のエッジを消すための道具が、自分で偽のエッジを作っていた
 * どれも動いてしまうので、実行しても気づけない。だから構造を突き合わせる。
 *
 * 依存パッケージなし。Node 18 以降。
 */
"use strict";

import fs from "node:fs";
import path from "node:path";

const KIND_PHASE = {
  single: "実行", fanout: "並列", reduce: "整理",
  verify: "検証", synthesize: "統合", gate: "承認",
};

let 落ちた = 0;
const 結果 = [];
function 検査(名, 通った, 詳しく) {
  結果.push({ 名, 通った, 詳しく });
  if (!通った) 落ちた++;
}

/* コードから「実際に動く部分」だけを残す。
   ⚠ ここを素朴な grep で済ませると必ず誤検知する。
      生成コードのコメントには agent( が出てくるし、
      プロンプト（テンプレートリテラル）の中にも文字として出てくる。
      どちらも動かないので、先に消してから数える。 */
function 動く部分だけ(code) {
  let out = "", i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i], d = code[i + 1];
    if (c === "/" && d === "*") {                     // ブロックコメント
      const e = code.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2; out += " "; continue;
    }
    if (c === "/" && d === "/") {                     // 行コメント
      const e = code.indexOf("\n", i);
      i = e < 0 ? n : e; continue;
    }
    if (c === "`") {                                  // テンプレートリテラル（プロンプト）
      i++;
      while (i < n) {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i] === "`") { i++; break; }
        // ${ } の中はコードなので残す
        if (code[i] === "$" && code[i + 1] === "{") {
          let depth = 1; i += 2; const s = i;
          while (i < n && depth > 0) {
            if (code[i] === "{") depth++;
            else if (code[i] === "}") depth--;
            i++;
          }
          out += code.slice(s, i - 1) + " ";
          continue;
        }
        i++;
      }
      out += ' "" '; continue;
    }
    if (c === '"' || c === "'") {                     // ふつうの文字列
      const q = c; i++;
      while (i < n && code[i] !== q) { if (code[i] === "\\") i++; i++; }
      i++; out += ' "" '; continue;
    }
    out += c; i++;
  }
  return out;
}

/* 図面の側から、段ごとに「AIを立てるノード」を数える */
function 図面の段(図) {
  const rk = {};
  const byId = Object.fromEntries(図.nodes.map(n => [n.id, n]));
  const depth = (id, seen) => {
    if (rk[id] != null) return rk[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const n = byId[id];
    const d = !n || !n.deps.length ? 0 : 1 + Math.max(...n.deps.map(x => depth(x, seen)));
    return (rk[id] = d);
  };
  図.nodes.forEach(n => depth(n.id, new Set()));
  const 段 = {};
  for (const n of 図.nodes) {
    if (n.kind === "gate" || n.kind === "reduce") continue;   // AIを立てない
    (段[rk[n.id]] ||= []).push(n);
  }
  return 段;
}

/* コードの側から、同時に走らせている塊を数える */
function コードの並列塊(code) {
  // まとめて走らせている段: const [a, b] = await parallel([...]) / const _段N = await parallel([
  const 束 = [...code.matchAll(/const (?:\[[^\]]+\]|_段\d+) = await parallel\(\[/g)].length;
  // 1本だけの段: const x = await parallel(...) / await spawn(...)
  const 単 = [...code.matchAll(/^\s*(?:const |let )?r_\w+ = await (?:parallel|spawn)\(/gm)].length;
  return { 束, 単 };
}

const 引数 = process.argv.slice(2);
if (引数.length < 2 || 引数.length % 2 !== 0) {
  console.error("使い方: node test/check-generated.mjs <図面.graphflow.json> <ワークフロー.js> [...]");
  process.exit(1);
}

for (let i = 0; i < 引数.length; i += 2) {
  const 図パス = 引数[i], コードパス = 引数[i + 1];
  const 図 = JSON.parse(fs.readFileSync(図パス, "utf8"));
  const code = fs.readFileSync(コードパス, "utf8");
  const 名 = path.basename(コードパス);

  /* (a) 素の agent( が残っていないか。
         上限を効かせるには全部 spawn( 経由でなければならない。
         コメントとプロンプトを消したうえで、ラッパ自身の呼び出しだけを許す。
         ⚠ ラッパの中の呼び出しは1つとは限らない。「書けない担当が見つからなければ
            書ける状態でもう一度」の作り込みで2つになる。第1引数が p のものを
            ラッパ自身とみなす（外の呼び出しは実際の値を渡すので p にならない）。 */
  const 動く = 動く部分だけ(code);
  const 裸のagent = [...動く.matchAll(/(?<![.\w])agent\(/g)]
    .filter(m => !/^agent\(p,\s*[^)]*\)/.test(動く.slice(m.index, m.index + 40)));
  検査(`${名}: 素の agent( が残っていない（spawn 経由になっている）`, 裸のagent.length === 0,
    裸のagent.map(m => `  …${動く.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\s+/g, " ")}`).join("\n"));

  /* (b) 動的に広がる配列を、残り枠で切り詰めているか */
  const 動的展開 = /parallel\(/.test(code);
  検査(`${名}: 動的に広がる配列を残り枠で切り詰めている`,
    !動的展開 || /枠内に収める\(/.test(code),
    動的展開 && !/枠内に収める\(/.test(code) ? "  parallel はあるが 枠内に収める( が無い" : "");

  /* (c) 決定性を壊すものが混ざっていないか（再開が壊れる） */
  const 非決定 = [...code.matchAll(/Date\.now\(|Math\.random\(|new Date\(/g)].map(m => m[0]);
  検査(`${名}: Date.now / Math.random / new Date が無い`, 非決定.length === 0,
    非決定.length ? `  見つかった: ${[...new Set(非決定)].join(", ")}` : "");

  /* (d) 🔴 図が言っている「同時に走る段」と、コードの塊が一致しているか */
  const 段 = 図面の段(図);
  // この図面（1枚目）に含まれる段だけを見る。ゲートで割れている場合は先頭の塊のみ。
  const 割れている = 図.nodes.some(n => n.kind === "gate");
  const 同時段 = Object.values(段).filter(ns => ns.length > 1).length;
  const { 束 } = コードの並列塊(code);
  検査(`${名}: 「同時に走る段」の数が図面とコードで一致`,
    割れている || 束 === 同時段,
    割れている ? "  （ゲートで割れているので、この検査は図面1枚ごとに行う）"
               : `  図面: ${同時段} / コード: ${束}`);

  /* (e) 上限が宣言だけになっていないか */
  const CAP宣言 = /const CAP = \d+/.test(code);
  const CAP参照 = (code.match(/CAP/g) || []).length;
  検査(`${名}: 上限が飾りになっていない`, !CAP宣言 || CAP参照 >= 4,
    CAP宣言 && CAP参照 < 4 ? `  CAP の出現が ${CAP参照} 箇所しかない＝止める経路が無い可能性` : "");
}

console.log();
for (const r of 結果) {
  console.log(`${r.通った ? "✅" : "❌"} ${r.名}`);
  if (!r.通った && r.詳しく) console.log(r.詳しく);
}
console.log(`\n${結果.length - 落ちた}/${結果.length} 通過`);
process.exit(落ちた ? 1 : 0);
