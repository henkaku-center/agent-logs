// Agent Logs — Survey question definitions
// Source: IRB-approved survey instruments (Japanese version)
// Phases: pre_study (Session 1), mid_semester (Session 6), post_study (Session 13)

const SURVEYS = {
  pre_study: {
    title: "Pre-Study Survey / 事前調査",
    description: "This survey helps us understand your background and experience with AI tools. Your responses are confidential. It takes approximately 25-30 minutes.",
    sections: [
      {
        id: "A0",
        title: "Background Information / 基本情報",
        description: "Please tell us about yourself.",
        phase: ["pre_study"],
        questions: [
          { id: "A0_1", text: "Age range / 年齢層", type: "radio", options: ["18-22", "23-29", "30-39", "40 or older", "Prefer not to answer"] },
          { id: "A0_2", text: "Gender / 性別", type: "radio", options: ["Male", "Female", "Non-binary", "Other", "Prefer not to answer"] },
          { id: "A0_3", text: "Education level / 在籍区分", type: "radio", options: ["Undergraduate", "Master's program", "Doctoral program", "Social science/humanities graduate student", "Other"] },
          { id: "A0_4", text: "Primary language used in daily life / 日常生活で主に使用する言語", type: "radio", options: ["Japanese", "English", "Chinese", "Other"] },
          { id: "A0_5", text: "Japanese language proficiency / 日本語能力", type: "radio", options: ["Native", "Elementary (JLPT N5-N4)", "Intermediate (JLPT N3)", "Advanced (JLPT N2-N1)", "Prefer not to answer"] },
          { id: "A0_6", text: "Approximate years of programming experience / プログラミング経験年数", type: "radio", options: ["None", "Less than 1 year", "1-3 years", "3+ years"] },
          { id: "A0_7", text: "Years of professional work experience / 職務経験年数", type: "radio", options: ["Not applicable / Student", "Less than 3 years", "3-10 years", "10+ years"] },
        ],
      },
      {
        id: "A1",
        title: "AI Tool Familiarity / AIツール習熟度",
        description: "Rate your familiarity with each type of AI tool.",
        phase: ["pre_study", "post_study"],
        scale: { min: 1, max: 7, minLabel: "No experience at all", maxLabel: "Frequently used and comfortable" },
        questions: [
          { id: "A1_1", text: "Code completion tools (GitHub Copilot, IDE inline suggestions) / コード補完ツール", type: "likert" },
          { id: "A1_2", text: "Conversational AI assistants (ChatGPT, Claude web) / 対話型AIアシスタント", type: "likert" },
          { id: "A1_3", text: "AI coding assistants in command-line (Claude Code, Aider) / コマンドラインAIコーディング支援", type: "likert" },
          { id: "A1_4", text: "AI agent orchestration platforms (multi-step AI workflows) / AIエージェント連携プラットフォーム", type: "likert" },
          { id: "A1_5", text: "AI tools combined with version management (GitHub integration) / バージョン管理とAIツールの統合", type: "likert" },
        ],
      },
      {
        id: "A2",
        title: "Task Delegation Judgment / タスク委任判断",
        description: "For each scenario, rate how appropriate it is for AI, explain your reasoning, and choose which tool you would use.",
        phase: ["pre_study", "post_study"],
        questions: [
          {
            id: "A2_1", type: "vignette",
            text: "Scenario 1: Generating REST API boilerplate for CRUD operations on a pre-existing database schema / シナリオ1: 既存データベーススキーマに対するCRUD操作用REST APIボイラープレートの生成",
          },
          {
            id: "A2_2", type: "vignette",
            text: "Scenario 2: Conducting user interviews with 3 participants about product ideas and target users / シナリオ2: 製品アイデアとターゲットユーザーについて3人の参加者にユーザーインタビューを実施",
          },
          {
            id: "A2_3", type: "vignette",
            text: "Scenario 3: Implementing a new feature with bugs; implementation is incomplete and error messages are unclear / シナリオ3: バグのある新機能の実装。実装は不完全でエラーメッセージが不明確",
          },
          {
            id: "A2_4", type: "vignette",
            text: "Scenario 4: Pitching a project to potential investors regarding your work and presentation / シナリオ4: 潜在的な投資家への自分の仕事とプレゼンテーションに関するプロジェクトの提案",
          },
          {
            id: "A2_5", type: "vignette",
            text: "Scenario 5: Evaluating whether AI-generated code follows security requirements correctly / シナリオ5: AI生成コードがセキュリティ要件に正しく従っているかの評価",
          },
        ],
        vignetteScale: { min: 1, max: 7, minLabel: "Completely inappropriate for AI", maxLabel: "Perfectly suited for AI" },
      },
      {
        id: "A3",
        title: "Self-Efficacy in Specifying Intent to AI / AIに意図を指定する自己効力感",
        description: "Rate your agreement with each statement.",
        phase: ["pre_study", "post_study"],
        scale: { min: 1, max: 7, minLabel: "Strongly disagree", maxLabel: "Strongly agree" },
        questions: [
          { id: "A3_1", text: "I can explain how to use an AI tool properly, and with 1-2 trial runs, get desirable results / AIツールの使い方を正しく説明でき、1-2回の試行で望ましい結果を得られる", type: "likert" },
          { id: "A3_2", text: "When an AI tool produces undesired output, I can identify what went wrong and correct it / AIツールが望ましくない出力を生成した場合、何が間違っていたかを特定し修正できる", type: "likert" },
          { id: "A3_3", text: "When facing a complex problem, I can break it down and create a prompt that works / 複雑な問題に直面したとき、それを分解し機能するプロンプトを作成できる", type: "likert" },
          { id: "A3_4", text: "I can adjust smaller sub-tasks and sub-questions to get better results from AI tools / AIツールからより良い結果を得るために、小さなサブタスクやサブクエスチョンを調整できる", type: "likert" },
          { id: "A3_5", text: "By following up with the AI tool, I can turn results into desired outcomes / AIツールとのフォローアップで、結果を望ましい成果に変換できる", type: "likert" },
        ],
      },
      {
        id: "A4",
        title: "Metacognitive Awareness of AI Collaboration / AI協働に関するメタ認知的認識",
        description: "Rate your agreement with each statement.",
        phase: ["pre_study", "post_study"],
        scale: { min: 1, max: 7, minLabel: "Strongly disagree", maxLabel: "Strongly agree" },
        questions: [
          { id: "A4_1", text: "I can clearly distinguish between AI output quality and actual correctness / AIの出力品質と実際の正確さを明確に区別できる", type: "likert" },
          { id: "A4_2", text: "I evaluate whether AI completes the task fully within the allotted time / AIが割り当てられた時間内にタスクを完全に完了したかを評価する", type: "likert" },
          { id: "A4_3", text: "When AI provides a solution, I pause to check whether it addresses my real problem / AIが解決策を提供したとき、一旦立ち止まってそれが本当の問題に対応しているか確認する", type: "likert" },
          { id: "A4_4", text: "I monitor my AI inquiry thinking process and notice gaps in my thinking / AI探究の思考プロセスを監視し、思考のギャップに気づく", type: "likert" },
        ],
      },
      {
        id: "A5",
        title: "Metacognitive Self-Regulation / メタ認知的自己調整 (MSLQ)",
        description: "Think about how you generally approach course work through AI support projects. Rate how much each statement applies to you.",
        phase: ["pre_study", "post_study"],
        scale: { min: 1, max: 7, minLabel: "Never applies", maxLabel: "Applies all the time" },
        questions: [
          { id: "A5_1", text: "During project work, I notice other important things that I need to accomplish / プロジェクト作業中、達成すべき他の重要なことに気づく", type: "likert", reverse: true },
          { id: "A5_2", text: "When taking on tasks each session, I set learning goals to guide my activities / 各セッションでタスクに取り組む際、活動を導く学習目標を設定する", type: "likert" },
          { id: "A5_3", text: "When confused, I go back and re-read what I didn't understand / 混乱したとき、戻って理解できなかった部分を読み直す", type: "likert" },
          { id: "A5_4", text: "If materials aren't understandable, I change how I approach them / 資料が理解できない場合、アプローチ方法を変える", type: "likert" },
          { id: "A5_5", text: "Before starting a task, I think about what I want to know / タスクを始める前に、何を知りたいかを考える", type: "likert" },
          { id: "A5_6", text: "I confirm my understanding of materials by asking myself questions / 自分に質問することで資料の理解を確認する", type: "likert" },
          { id: "A5_7", text: "I adjust work methods to fit task requirements / タスクの要件に合わせて作業方法を調整する", type: "likert" },
          { id: "A5_8", text: "Sometimes I do things without knowing why / 時々なぜかわからずに物事を行う", type: "likert", reverse: true },
          { id: "A5_9", text: "I can answer questions myself; I don't only learn from others / 自分で質問に答えられる。他者からだけ学ぶわけではない", type: "likert" },
          { id: "A5_10", text: "When I feel confused, eventually I figure out how to do it properly / 混乱を感じても、最終的には正しいやり方を見つける", type: "likert" },
          { id: "A5_11", text: "When getting stuck on tasks, I try to do it correctly or change my strategy / タスクで行き詰まったとき、正しく行うか戦略を変える", type: "likert" },
          { id: "A5_12", text: "When finishing a task, I evaluate if I understand what I accomplished / タスクを終えるとき、達成したことを理解しているか評価する", type: "likert" },
        ],
      },
      {
        id: "A_ID1",
        title: "Cognitive Reflection Test / 認知反映テスト (CRT)",
        description: "Answer each question. Most people get these wrong on first try — take your time.",
        phase: ["pre_study"],
        questions: [
          { id: "AID1_1", text: "A bat and ball cost $1.10 total. The bat costs $1.00 more than the ball. How much does the ball cost? / バットとボールの合計は$1.10。バットはボールより$1.00高い。ボールはいくら？", type: "text", placeholder: "e.g. $0.05" },
          { id: "AID1_2", text: "If 5 machines take 5 minutes to make 5 widgets, how long does it take 100 machines to make 100 widgets? / 5台の機械が5個の部品を5分で作る場合、100台の機械が100個の部品を作るのにかかる時間は？", type: "text", placeholder: "e.g. 5 minutes" },
          { id: "AID1_3", text: "In a lake with lily pads that double in size daily, covering the lake in 48 days, how long to cover half? / 毎日2倍に増える睡蓮が48日で湖を覆う場合、半分を覆うのにかかる日数は？", type: "text", placeholder: "e.g. 47 days" },
          { id: "AID1_4", text: "In a race, if you pass the person in 2nd place, what position are you in? / レースで2位の人を追い越したら、あなたの順位は？", type: "text", placeholder: "e.g. 2nd" },
          { id: "AID1_5", text: "A farmer has 15 sheep. All but 8 die. How many remain? / 農家に15頭の羊。8頭を除いて全部死んだ。残りは何頭？", type: "text", placeholder: "e.g. 8" },
          { id: "AID1_6", text: "Emily has 3 daughters. The oldest two are named April and May. What is the 3rd daughter's name? / エミリーには3人の娘。上の2人はエイプリルとメイ。3人目の名前は？", type: "text", placeholder: "e.g. Emily" },
          { id: "AID1_7", text: "A field is 3 feet wide and 3 feet long. How many 3-foot-wide segments fit? / 幅3フィート、長さ3フィートの畑。3フィート幅の区画はいくつ入る？", type: "text", placeholder: "e.g. 1" },
        ],
      },
      {
        id: "A_ID2",
        title: "Need for Cognition / 認知欲求 (NFC-18)",
        description: "Rate how characteristic each statement is of you.",
        phase: ["pre_study"],
        scale: { min: 1, max: 7, minLabel: "Very uncharacteristic of me", maxLabel: "Very characteristic of me" },
        questions: [
          { id: "AID2_1", text: "I prefer simple problems to complex ones / 複雑な問題よりも単純な問題を好む", type: "likert", reverse: true },
          { id: "AID2_2", text: "I like considering many options when solving problems / 問題解決時に多くの選択肢を検討するのが好きだ", type: "likert" },
          { id: "AID2_3", text: "Thinking is not my idea of fun / 考えることは楽しいことではない", type: "likert", reverse: true },
          { id: "AID2_4", text: "I prefer tasks that require little thought once learned / 一度覚えたら考えなくて済むタスクを好む", type: "likert", reverse: true },
          { id: "AID2_5", text: "I try to anticipate and avoid situations where I'll have to think deeply / 深く考えなければならない状況を予測し回避しようとする", type: "likert", reverse: true },
          { id: "AID2_6", text: "I find satisfaction in deliberating long and hard / 長く深く熟考することに満足を感じる", type: "likert" },
          { id: "AID2_7", text: "I only think as hard as I have to / 必要な分だけ考える", type: "likert", reverse: true },
          { id: "AID2_8", text: "I prefer long-term projects that require thought over short-term ones / 短期プロジェクトより思考を要する長期プロジェクトを好む", type: "likert" },
          { id: "AID2_9", text: "I don't like tasks that require a lot of thinking / 多くの思考を要するタスクは好きではない", type: "likert", reverse: true },
          { id: "AID2_10", text: "The idea of relying on thought to get ahead appeals to me / 思考に頼って前進するという考えは魅力的だ", type: "likert" },
          { id: "AID2_11", text: "I enjoy coming up with new solutions to problems / 問題に対する新しい解決策を考え出すのが楽しい", type: "likert" },
          { id: "AID2_12", text: "Learning new ways to think doesn't excite me / 新しい考え方を学ぶことにワクワクしない", type: "likert", reverse: true },
          { id: "AID2_13", text: "I am happy when I have solved a difficult puzzle / 難しいパズルを解いたとき幸せだ", type: "likert" },
          { id: "AID2_14", text: "Abstract concepts appeal to me / 抽象的な概念に魅力を感じる", type: "likert" },
          { id: "AID2_15", text: "I prefer intellectual, complex tasks over simple ones / 単純なタスクより知的で複雑なタスクを好む", type: "likert" },
          { id: "AID2_16", text: "I feel relief rather than satisfaction after completing a task requiring mental effort / 精神的努力を要するタスク完了後、満足よりも安堵を感じる", type: "likert", reverse: true },
          { id: "AID2_17", text: "It's enough for me that something gets the job done; I don't care how or why / 何かが仕事を完了させればそれで十分。どのように、なぜかは気にしない", type: "likert", reverse: true },
          { id: "AID2_18", text: "I usually end up deliberating about issues even when they don't affect me personally / 個人的に影響しない問題についても熟考することが多い", type: "likert" },
        ],
      },
      {
        id: "A_ID3",
        title: "Intellectual Humility / 知的謙虚さ",
        description: "Rate your agreement with each statement.",
        phase: ["pre_study"],
        scale: { min: 1, max: 7, minLabel: "Strongly disagree", maxLabel: "Strongly agree" },
        questions: [
          { id: "AID3_1", text: "I might be wrong about some things; my understanding or opinions might be mistaken / 自分が間違っているかもしれない。理解や意見が誤りかもしれない", type: "likert" },
          { id: "AID3_2", text: "When new evidence contradicts my opinions, I reconsider my position / 新しい証拠が自分の意見と矛盾するとき、立場を再考する", type: "likert" },
          { id: "AID3_3", text: "I recognize the value of different viewpoints / 異なる視点の価値を認識している", type: "likert" },
          { id: "AID3_4", text: "I'm aware my confidence and certainty might be open to being wrong / 自分の自信と確信は間違っている可能性があることを認識している", type: "likert" },
          { id: "AID3_5", text: "Direct evidence might change my mind and lead to different opinions / 直接的な証拠は考えを変え、異なる意見につながる可能性がある", type: "likert" },
          { id: "AID3_6", text: "Even if I dislike others' opinions, I can still identify their strengths / 他者の意見が気に入らなくても、その長所を識別できる", type: "likert" },
        ],
      },
    ],
  },

  mid_semester: {
    title: "Mid-Semester Check-in / 学期中間チェックイン",
    description: "Brief check-in on your AI tool usage and course progress. Takes approximately 5-6 minutes.",
    sections: [
      {
        id: "B1",
        title: "AI Tool Use Impact on Course Concepts / AIツール使用がコース概念に与えた影響",
        description: "Which course concepts have changed how you use AI tools? Select all that apply.",
        phase: ["mid_semester"],
        questions: [
          {
            id: "B1_1", text: "Select all concepts that have changed how you use AI tools / AI ツールの使い方を変えた概念をすべて選択", type: "checkbox",
            options: [
              "Task decomposition (breaking work into AI-suitable tasks) / タスク分解",
              "Document-Driven Development (DDD)",
              "Vibe coding (natural-language-driven development) / バイブコーディング",
              "GitHub integration (using version control with AI) / GitHub連携",
              "Prompt structuring (writing specific/structured prompts) / プロンプト構造化",
              "Skills/MCP framework (packaging AI behaviors for reuse) / スキル/MCPフレームワーク",
              "Security awareness (understanding AI delegation risks) / セキュリティ意識",
              "None of the above / 上記のいずれでもない",
            ],
          },
        ],
      },
      {
        id: "B2",
        title: "AI Use Distribution by Project Phase / プロジェクトフェーズ別AI使用分布",
        description: "What percentage of your AI tool use occurs at each project phase? Total must equal 100%.",
        phase: ["mid_semester"],
        questions: [
          {
            id: "B2_1", text: "Distribute your AI usage across project phases / プロジェクトフェーズ全体でのAI使用を配分", type: "percentage",
            categories: [
              "Ideation / brainstorming / アイデア出し",
              "Architecture / planning / 設計・計画",
              "Coding / building / コーディング・構築",
              "Testing / debugging / テスト・デバッグ",
              "Documentation / ドキュメント",
              "Presentation / communication / 発表・コミュニケーション",
            ],
          },
        ],
      },
      {
        id: "B3",
        title: "Free-form Reflection / 自由形式の振り返り",
        description: "Reflect briefly on your experience.",
        phase: ["mid_semester"],
        questions: [
          { id: "B3_1", text: "What is one thing AI helped you recognize that you hadn't expected beforehand? / AIが事前に予想していなかった気づきを与えてくれたことは何ですか？", type: "textarea" },
          { id: "B3_2", text: "Describe one approach to AI work that changed based on what you learned in this course / このコースで学んだことに基づいて、AI作業へのアプローチで変わったことを1つ説明してください", type: "textarea" },
        ],
      },
    ],
  },

  post_study: {
    title: "Post-Study Survey / 事後調査",
    description: "Final survey measuring changes in your AI collaboration skills. Takes approximately 25-30 minutes. Sections A1-A5 are repeated from the pre-study survey.",
    sections: [], // Uses sections A1-A5 from pre_study (filtered by phase)
  },
};

// Export for use in portal.js
if (typeof window !== "undefined") window.SURVEYS = SURVEYS;
