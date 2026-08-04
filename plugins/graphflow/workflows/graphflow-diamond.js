/* GraphFlow が書き出すスクリプトの見本。
   使い方: /graphflow:graphflow-diamond に調べたいテーマを渡す。
   自分の業務に合わせて作り直すときは `graphflow` で設計盤を開く。 */
export const meta = {
  name: 'graphflow-diamond',
  description: 'ダイヤモンド型の基本形。角度を分けて調べ、コードで畳み、別文脈で検証し、通ったものだけで仕上げる',
  phases: [
    { title: '調査', detail: '観点ごとに並列で集める' },
    { title: '検証', detail: '作業者と別文脈で反証を試みる' },
    { title: '統合', detail: '検証を通った材料だけで仕上げる' },
  ],
}

const TOPIC = typeof args === 'string' ? args : (args && args.topic) || ''
if (!TOPIC) return { error: 'テーマが渡されていません。/graphflow:graphflow-diamond <調べたいこと> のように渡します。' }

const ANGLES = (args && args.angles) || [
  '公式・一次情報',
  '実際の利用者の声',
  '反対意見と失敗例',
  '直近12か月の変化',
  '日本市場での事情',
]

const CAP = 12

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'source_url', 'confidence'],
        properties: {
          claim: { type: 'string' },
          source_url: { type: 'string' },
          published_at: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['KEEP', 'DROP', 'UNVERIFIED'] },
    reason: { type: 'string' },
    needed: { type: 'string' },
  },
}

phase('調査')
const gathered = (await parallel(ANGLES.map(angle => () =>
  agent(`「${TOPIC}」について、次の角度から調べてください。

観点: ${angle}

すべての発見に出典URL・公開日・確信度を付けます。
出典のない主張は書きません。

FAIL: 出典を確認できない場合は、推測で埋めず、その発見を落として理由を残します。`, {
    label: `調査:${angle}`,
    phase: '調査',
    schema: FINDINGS,
  })
))).filter(Boolean)

log(`調査: ${gathered.length}/${ANGLES.length} 件の観点が返りました`)

// 整理はLLMを呼ばない。重複削除と件数確認は素のコードの方が安く速く確実。
const flat = gathered.flatMap(g => g.findings || [])
const seen = new Set()
const unique = flat.filter(f => {
  const k = (f.source_url || '') + '|' + (f.claim || '').slice(0, 60)
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
const status = gathered.length === ANGLES.length ? 'OK' : 'INCOMPLETE'
log(`整理: 予定 ${ANGLES.length} 観点 / 実際 ${gathered.length} / 状態 ${status} — 主張 ${flat.length}件 → 重複を除いて ${unique.length}件`)

phase('検証')
// 検証者には作業者の会話履歴を渡さない。完成物と基準だけを渡す。
const judged = (await parallel(unique.map((f, i) => () =>
  agent(`あなたは作成者ではなく、独立した検証者です。
作成者の推論や会話履歴は参照しません。渡された主張と基準だけで判断します。

以下の主張が間違っている可能性を優先して探してください。

1. 主張は出典によって本当に支持されているか
2. 情報は現在も有効か
3. 出典URLは実在し、該当内容を含んでいるか
4. 数字・日付・固有名詞に矛盾がないか
5. 推測が事実として書かれていないか

確認そのものができない場合は DROP ではなく UNVERIFIED にします。

主張: ${JSON.stringify(f)}`, {
    label: `検証:${i + 1}`,
    phase: '検証',
    schema: VERDICT,
  }).then(v => ({ ...f, ...v }))
))).filter(Boolean)

const kept = judged.filter(v => v.verdict === 'KEEP')
const dropped = judged.filter(v => v.verdict === 'DROP')
const unverified = judged.filter(v => v.verdict === 'UNVERIFIED')
log(`検証: KEEP ${kept.length} / DROP ${dropped.length} / UNVERIFIED ${unverified.length}`)

phase('統合')
const report = await agent(`「${TOPIC}」について、検証を通った材料だけを使って報告をまとめてください。

材料（KEEP のみ）:
${JSON.stringify(kept, null, 2)}

確認できなかった主張（本文では使わず、末尾に「未確認」として列挙する）:
${JSON.stringify(unverified.map(u => ({ claim: u.claim, needed: u.needed })), null, 2)}

材料が足りない論点は、埋めずに「材料不足」と明記します。`, {
  label: '統合',
  phase: '統合',
  schema: {
    type: 'object',
    required: ['report'],
    properties: {
      report: { type: 'string' },
      open_questions: { type: 'array', items: { type: 'string' } },
    },
  },
})

return {
  topic: TOPIC,
  status,
  counts: { gathered: flat.length, unique: unique.length, kept: kept.length, dropped: dropped.length, unverified: unverified.length },
  report: report && report.report,
  open_questions: (report && report.open_questions) || [],
  cap: CAP,
}
