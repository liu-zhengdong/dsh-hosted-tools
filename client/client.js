window.__ModuleLoader__.load({
  id: "dsh-hosted-tools",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var createElement = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var name = "dsh-hosted-tools";
    var inject = ["slots", "remote"];

    // ---- 与宿主侧 src/auth-remote.js 对应的 Remote 描述符 --------------------
    // client 要求所有参数 codec 为 strict；宿主真正用的是 SRC fallback 的
    // src-json，所以这里的 create() 只是 client 侧的形式占位。
    function passthrough(typeSymbol) {
      return {
        mode: "strict",
        typeSymbol: typeSymbol,
        create: function () {
          return { parse: function (value) { return value; } };
        },
      };
    }
    function param(field) {
      return { name: field, wire: field, source: "json", codec: passthrough(field) };
    }
    var CONTRIBUTION = {
      package: "dsh-hosted-tools",
      descriptors: [
        {
          id: "dsh-hosted-tools#hostedToolsAuth/flows",
          service: "hostedToolsAuth",
          namespace: "hostedToolsAuth",
          method: "flows",
          invocation: { kind: "direct" },
          parameters: [],
          result: { mode: "src-json" },
        },
        {
          id: "dsh-hosted-tools#hostedToolsAuth/status",
          service: "hostedToolsAuth",
          namespace: "hostedToolsAuth",
          method: "status",
          invocation: { kind: "direct" },
          parameters: [],
          result: { mode: "src-json" },
        },
        {
          id: "dsh-hosted-tools#hostedToolsAuth/cancel",
          service: "hostedToolsAuth",
          namespace: "hostedToolsAuth",
          method: "cancel",
          invocation: { kind: "direct" },
          parameters: [param("key")],
          result: { mode: "src-json" },
        },
        {
          id: "dsh-hosted-tools#hostedToolsAuth/respond",
          service: "hostedToolsAuth",
          namespace: "hostedToolsAuth",
          method: "respond",
          invocation: { kind: "direct" },
          parameters: [param("requestId"), param("answer")],
          result: { mode: "src-json" },
        },
        {
          id: "dsh-hosted-tools#hostedToolsAuth/begin",
          service: "hostedToolsAuth",
          namespace: "hostedToolsAuth",
          method: "begin",
          invocation: { kind: "direct" },
          parameters: [param("key"), param("method")],
          cancellation: { parameter: "signal" },
          mode: "stream",
          result: { mode: "src-json" },
        },
      ],
    };

    // ---- 调用工具 ----------------------------------------------------------
    function errorMessage(error) {
      if (error === null || error === undefined) return "未知错误";
      if (typeof error === "string") return error;
      return error.message || String(error);
    }
    /**
     * Remote 调用返回的是 {ok,value} | {ok,error} 信封，取值前必须解包。
     * @param response - invoke() 的结果。
     * @returns 信封里的 value。
     */
    function unwrap(response) {
      if (response && response.ok === true) return response.value;
      var failure = response && response.error;
      if (!failure) throw new Error("Remote 调用没有返回结果");
      throw new Error(failure.code ? failure.code + "：" + failure.message : String(failure.message));
    }
    /**
     * 取自己挂载的 Remote 命名空间。它是 apply 期间由 $mount 动态提供的，不能写进
     * inject（声明了就会一直等它出现，反而永远激活不了），所以用 ctx.get 做可选查找。
     * @param ctx - 插件上下文。
     * @returns hostedToolsAuth 命名空间服务。
     */
    function namespace(ctx) {
      var api = ctx.get("remote.hostedToolsAuth");
      if (api === undefined) throw new Error("hostedToolsAuth Remote 命名空间尚未挂载");
      return api;
    }

    // ---- 样式 --------------------------------------------------------------
    var S = {
      page: { display: "flex", flexDirection: "column", gap: "16px", fontSize: "13px" },
      card: {
        display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px",
        border: "1px solid var(--border, #e0e0e0)", borderRadius: "8px",
      },
      head: { display: "flex", alignItems: "center", gap: "8px" },
      title: { fontWeight: 600, fontSize: "14px" },
      badge: {
        fontSize: "11px", padding: "1px 8px", borderRadius: "999px",
        background: "var(--accent, #4c8dff)", color: "#fff",
      },
      hint: { color: "var(--text-secondary, #888)", lineHeight: 1.6 },
      warn: { color: "var(--warning, #d29922)", lineHeight: 1.6 },
      error: { color: "var(--danger, #e5534b)", lineHeight: 1.6, wordBreak: "break-word" },
      row: { display: "flex", flexDirection: "column", gap: "4px" },
      actions: { display: "flex", gap: "8px", flexWrap: "wrap" },
      btn: {
        padding: "5px 14px", fontSize: "12px", cursor: "pointer", borderRadius: "6px",
        border: "1px solid var(--accent, #4c8dff)", background: "var(--accent, #4c8dff)", color: "#fff",
      },
      btnSubtle: {
        padding: "5px 14px", fontSize: "12px", cursor: "pointer", borderRadius: "6px",
        border: "1px solid var(--border, #d0d0d0)", background: "transparent", color: "inherit",
      },
      code: { fontFamily: "monospace", fontSize: "15px", letterSpacing: "2px", fontWeight: 600 },
      link: { color: "var(--accent, #4c8dff)", wordBreak: "break-all" },
      input: {
        padding: "5px 8px", fontSize: "12px", borderRadius: "5px", width: "320px",
        border: "1px solid var(--border, #d0d0d0)", background: "transparent", color: "inherit",
      },
      section: { fontWeight: 600, fontSize: "14px" },
      divider: { borderTop: "1px solid var(--border, #e0e0e0)" },
      group: { display: "flex", flexDirection: "column", gap: "12px" },
      toolRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" },
      toolText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
      mono: { fontFamily: "monospace", fontSize: "12px" },
      seg: {
        display: "flex", flexShrink: 0, borderRadius: "6px", overflow: "hidden",
        border: "1px solid var(--border, #d0d0d0)",
      },
      segOn: {
        padding: "4px 10px", fontSize: "12px", cursor: "pointer", border: "none",
        background: "var(--accent, #4c8dff)", color: "#fff",
      },
      segOff: {
        padding: "4px 10px", fontSize: "12px", cursor: "pointer", border: "none",
        background: "transparent", color: "inherit",
      },
    };

    // ---- 登录面板 ----------------------------------------------------------
    var PROVIDERS = [
      { id: "xai", label: "xAI / Grok", about: "Grok 网页搜索、X 搜索、代码执行、图像生成与改图" },
      { id: "openai-codex", label: "OpenAI Codex", about: "ChatGPT 网页搜索与图像生成（需 ChatGPT Plus / Pro 订阅）" },
    ];
    var FLOW_PREFIX = "llm-pi-ai/";

    /**
     * 一条挂起 prompt 的作答控件。
     * @param props.prompt - {kind:"select"|"secret"|"text", message?, options?, placeholder?}
     * @param props.onAnswer - 提交答案。
     */
    function PromptView(props) {
      var prompt = props.prompt || {};
      var text = useState("");
      var value = text[0];
      var setValue = text[1];

      if (prompt.kind === "select") {
        var options = Array.isArray(prompt.options) ? prompt.options : [];
        return createElement("div", { style: S.row },
          createElement("div", { style: S.hint }, prompt.message || "请选择"),
          createElement("div", { style: S.actions },
            options.map(function (option) {
              var id = typeof option === "string" ? option : (option.id != null ? option.id : option.value);
              var label = typeof option === "string" ? option : (option.label || String(id));
              return createElement("button", {
                key: String(id), style: S.btnSubtle,
                onClick: function () { props.onAnswer(id); },
              }, label);
            }),
          ),
        );
      }

      return createElement("div", { style: S.row },
        createElement("div", { style: S.hint }, prompt.message || ""),
        createElement("div", { style: S.actions },
          createElement("input", {
            style: S.input,
            type: prompt.kind === "secret" ? "password" : "text",
            placeholder: prompt.placeholder || "",
            value: value,
            autoFocus: true,
            onChange: function (event) { setValue(event.target.value); },
            onKeyDown: function (event) { if (event.key === "Enter") props.onAnswer(value); },
          }),
          createElement("button", { style: S.btnSubtle, onClick: function () { props.onAnswer(value); } }, "提交"),
        ),
      );
    }

    /**
     * 一个 provider 的登录行。
     * @param props.ctx - 插件上下文。
     * @param props.provider - {id, label, about}。
     * @param props.flow - flows() 里对应的登录流，未查到为 null。
     * @param props.account - status() 里对应的凭据现状，可能为 null。
     */
    function ProviderRow(props) {
      var key = FLOW_PREFIX + props.provider.id;
      var st = useState("idle");
      var status = st[0];
      var setStatus = st[1];
      var er = useState(null);
      var error = er[0];
      var setError = er[1];
      var nt = useState([]);
      var notices = nt[0];
      var setNotices = nt[1];
      var pr = useState(null);
      var pending = pr[0];
      var setPending = pr[1];
      var stream = useRef(null);

      useEffect(function () {
        return function () {
          if (stream.current) stream.current.dispose();
          stream.current = null;
        };
      }, []);

      function begin() {
        setStatus("running");
        setError(null);
        setNotices([]);
        setPending(null);
        var handle;
        try {
          handle = namespace(props.ctx).begin(key, "oauth");
        } catch (failure) {
          setStatus("failed");
          setError(errorMessage(failure));
          return;
        }
        stream.current = handle;
        (async function () {
          try {
            for await (var item of handle) {
              if (!item || typeof item !== "object") continue;
              if (item.type === "notice") {
                if (item.notice) setNotices(function (list) { return list.concat([item.notice]); });
              } else if (item.type === "prompt") {
                setPending({ requestId: item.requestId, prompt: item.prompt });
              } else if (item.type === "prompt-done") {
                setPending(null);
              } else if (item.type === "settled") {
                setStatus(item.status === "authorized" ? "authorized" : "cancelled");
              } else if (item.type === "failed") {
                setStatus("failed");
                setError(item.code ? item.code + "：" + item.message : String(item.message || "登录失败"));
              }
            }
            setStatus(function (current) { return current === "running" ? "cancelled" : current; });
          } catch (failure) {
            setStatus("failed");
            setError(errorMessage(failure));
          } finally {
            stream.current = null;
          }
        })();
      }

      function cancel() {
        if (stream.current) stream.current.dispose();
        stream.current = null;
        try {
          namespace(props.ctx).cancel(key).catch(function () {});
        } catch (failure) {
          /* 已经不在登录中，忽略 */
        }
        setStatus("idle");
        setPending(null);
      }

      function answer(value) {
        if (!pending) return;
        setPending(null);
        try {
          namespace(props.ctx).respond(pending.requestId, value).catch(function () {});
        } catch (failure) {
          setStatus("failed");
          setError(errorMessage(failure));
        }
      }

      var loggedIn =
        status === "authorized" ||
        (props.account !== null &&
          props.account !== undefined &&
          props.account.authorized === true &&
          props.account.expired !== true);
      var expired = !loggedIn && props.account !== null && props.account !== undefined && props.account.expired === true;

      var children = [];
      var head = [createElement("span", { key: "t", style: S.title }, props.provider.label)];
      if (status === "running") head.push(createElement("span", { key: "b", style: S.hint }, "登录中…"));
      else if (loggedIn) head.push(createElement("span", { key: "b", style: S.badge }, "已登录"));
      else if (expired) head.push(createElement("span", { key: "b", style: S.hint }, "凭据已过期"));
      else head.push(createElement("span", { key: "b", style: S.hint }, "未登录"));
      children.push(createElement("div", { key: "head", style: S.head }, head));
      children.push(createElement("div", { key: "about", style: S.hint }, props.provider.about));

      if (props.flow === null) {
        children.push(createElement("div", { key: "missing", style: S.warn },
          "没有找到登录流 " + key + "。这个流由 llm-pi-ai 插件注册，请确认它已加载。"));
      }

      var buttons = [];
      if (status !== "running") {
        buttons.push(createElement("button", {
          key: "go", style: S.btn, onClick: begin,
          disabled: props.flow === null,
        }, loggedIn ? "重新登录" : "登录"));
      } else {
        buttons.push(createElement("button", { key: "stop", style: S.btnSubtle, onClick: cancel }, "取消"));
      }
      children.push(createElement("div", { key: "actions", style: S.actions }, buttons));

      notices.forEach(function (notice, index) {
        var parts = [];
        if (notice.message) parts.push(createElement("div", { key: "m", style: S.hint }, notice.message));
        if (notice.code) parts.push(createElement("div", { key: "c", style: S.code }, notice.code));
        if (notice.url) {
          parts.push(createElement("a", {
            key: "u", style: S.link, href: notice.url, target: "_blank", rel: "noreferrer",
          }, notice.url));
        }
        children.push(createElement("div", { key: "n" + index, style: S.row }, parts));
      });

      if (pending) {
        children.push(createElement(PromptView, {
          key: "prompt", prompt: pending.prompt, onAnswer: answer,
        }));
      }
      if (status === "failed" && error) {
        children.push(createElement("div", { key: "error", style: S.error }, error));
      }

      return createElement("div", { style: S.card }, children);
    }

    /**
     * 「插件设置」里的登录面板。挂载失败、流清单失败都显示在这里，不向外抛。
     * @param props.ctx - 插件上下文。
     * @param props.mount - 惰性挂载 Remote 命名空间，返回 null 或错误文本。
     */
    function AuthPanel(props) {
      var st = useState({ phase: "mounting" });
      var state = st[0];
      var setState = st[1];

      useEffect(function () {
        var alive = true;
        props.mount().then(function (failure) {
          if (!alive) return;
          if (failure !== null) {
            setState({ phase: "failed", message: failure });
            return;
          }
          setState({ phase: "loading" });
          return Promise.all([
            namespace(props.ctx).flows().then(unwrap),
            namespace(props.ctx).status().then(unwrap),
          ]).then(
            function (results) {
              if (!alive) return;
              setState({
                phase: "ready",
                flows: Array.isArray(results[0]) ? results[0] : [],
                accounts: Array.isArray(results[1]) ? results[1] : [],
              });
            },
            function (error) {
              if (alive) setState({ phase: "failed", message: errorMessage(error) });
            },
          );
        });
        return function () { alive = false; };
      }, []);

      if (state.phase === "mounting") {
        return createElement("div", { style: S.hint }, "正在挂载登录服务…");
      }
      if (state.phase === "failed") {
        return createElement("div", { style: S.error }, "登录服务不可用：" + state.message);
      }
      if (state.phase === "loading") {
        return createElement("div", { style: S.hint }, "正在读取登录流…");
      }

      var flows = state.flows;
      var accounts = state.accounts;
      return createElement("div", { style: S.page },
        createElement("div", { style: S.hint },
          "登录令牌写入本机凭据库，与 pi-ai provider 的登录共用；登录后托管工具即可直接使用。"),
        PROVIDERS.map(function (provider) {
          var key = FLOW_PREFIX + provider.id;
          var flow = null;
          for (var index = 0; index < flows.length; index += 1) {
            if (flows[index] && flows[index].key === key) flow = flows[index];
          }
          var account = null;
          for (var position = 0; position < accounts.length; position += 1) {
            if (accounts[position] && accounts[position].provider === provider.id) account = accounts[position];
          }
          return createElement(ProviderRow, {
            key: provider.id, ctx: props.ctx, provider: provider, flow: flow, account: account,
          });
        }),
      );
    }

    // ---- 工具暴露面板 -------------------------------------------------------
    // 读写都走宿主侧 dsh-settings 暴露的 configForms：它给每个插件条目一个表单
    // （当前值 + 串行写队列 + 冲突自动重读）。schema 里的 comment/description 就是
    // src/index.js 给每个工具字段写的界面文案，客户端因此不再维护一份工具表。
    var NAMESPACE = "dsh-hosted-tools";
    var MODES = [["off", "不暴露"], ["sync", "同步"], ["async", "后台异步"]];

    /**
     * describe 下发的是 schemastery 的骨架 JSON：节点按编号复用在 refs 里，根节点也在其中
     * （编号就是 uid），dict 里的字段值是编号而不是节点本身。这里把它摊平成好查的形态。
     */
    function schemaNodes(schema) {
      if (!schema || !schema.refs || schema.uid === undefined) return { refs: {}, root: schema };
      return { refs: schema.refs, root: schema.refs[String(schema.uid)] };
    }

    /** 取一个字段的界面文案（comment 是名称，description 是说明）。 */
    function fieldMeta(nodes, field) {
      var dict = nodes.root && nodes.root.dict;
      if (!dict) return {};
      var node = dict[field];
      if (typeof node === "number" || typeof node === "string") node = nodes.refs[String(node)];
      return node && node.meta ? node.meta : {};
    }

    /**
     * 读一次当前状态：表单给值，共享镜像给 schema（文案与字段顺序）。
     */
    function readExposure(forms) {
      var snapshot = forms.get(NAMESPACE).getSnapshot();
      var view = forms.describe().namespace(NAMESPACE);
      return {
        status: snapshot.status,
        mode: snapshot.mode,
        value: snapshot.value || {},
        user: snapshot.user || {},
        schema: view ? view.schema : undefined,
      };
    }

    /**
     * 「暴露给 DSH 的工具」段：每个已实现工具一行三态。
     * @param props.forms - 宿主的 configForms 服务。
     */
    function ExposurePanel(props) {
      var forms = props.forms;
      var viewState = useState(function () { return readExposure(forms); });
      var view = viewState[0];
      var setView = viewState[1];
      var busyState = useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var failState = useState(null);
      var failure = failState[0];
      var setFailure = failState[1];

      useEffect(function () {
        var refresh = function () { setView(readExposure(forms)); };
        var offForm = forms.get(NAMESPACE).subscribe(refresh);
        var mirror = forms.describe();
        var offMirror = mirror.subscribe(refresh);
        mirror.ensure();
        refresh();
        return function () { offForm(); offMirror(); };
      }, []);

      /**
       * 改一个工具：选回 schema 默认值就删掉这条覆盖（而不是把默认值写进文件），
       * profile 里因此只留与默认不同的部分。
       */
      function choose(field, mode, isDefault) {
        var form = forms.get(NAMESPACE);
        setBusy(field);
        setFailure(null);
        (isDefault ? form.unset(field) : form.set(field, mode)).then(
          function (accepted) {
            setBusy(null);
            if (!accepted) setFailure("保存失败：配置在保存期间被改动过，已重新读取，请再试一次。");
          },
          function (error) { setBusy(null); setFailure(errorMessage(error)); },
        );
      }

      if (view.mode === "memory" || view.status === "unavailable") {
        return createElement("div", { style: S.warn },
          "当前页面不直连宿主配置（非本机页面），工具暴露设置只能在本机页面里改。");
      }
      if (view.status === "loading") {
        return createElement("div", { style: S.hint }, "正在读取工具配置…");
      }

      var ready = view.status === "ready";
      var nodes = schemaNodes(view.schema);
      var fields = nodes.root && nodes.root.dict ? Object.keys(nodes.root.dict) : Object.keys(view.value);
      return createElement("div", { style: S.group },
        createElement("div", { style: S.section }, "暴露给 DSH 的工具"),
        createElement("div", { style: S.hint },
          "注册过的工具模型才看得见。同步工具等结果；后台异步工具立刻回执，跑完把结果作为一条消息注入"
          + "当前会话，这时会额外提供 hosted_jobs 供查看与取回。"),
        fields.map(function (field) {
          var meta = fieldMeta(nodes, field);
          var current = view.value[field];
          // 这一项在 profile 里有没有显式覆盖：选中的默认值再点一下就是清掉覆盖。
          var overridden = view.user[field] !== undefined;
          return createElement("div", { key: field, style: S.card },
            createElement("div", { style: S.toolRow },
              createElement("div", { style: S.toolText },
                createElement("div", { style: S.title }, meta.comment || field),
                createElement("div", { style: S.mono }, field),
                createElement("div", { style: S.hint }, meta.description || ""),
              ),
              createElement("div", { style: S.seg }, MODES.map(function (pair) {
                var selected = current === pair[0];
                return createElement("button", {
                  key: pair[0],
                  style: selected ? S.segOn : S.segOff,
                  disabled: !ready || busy === field || (selected && !overridden),
                  onClick: function () { choose(field, pair[0], meta.default === pair[0]); },
                }, pair[1]);
              })),
            ),
          );
        }),
        failure === null ? null : createElement("div", { style: S.error }, failure),
      );
    }

    /**
     * 页签整体：登录 + 工具暴露。configForms 由 dsh-client-ui-settings 提供，不写进
     * inject（声明了就会一直等它出现，缺这个插件的部署里整个页签都激活不了），
     * 改为渲染时可选查找——页签是用户点开才渲染的，那时所有插件都已激活。
     * @param props.ctx - 插件上下文。
     * @param props.mount - 惰性挂载登录 Remote 命名空间，返回 null 或错误文本。
     */
    function HostedToolsPanel(props) {
      var forms = props.ctx.get("configForms");
      return createElement("div", { style: S.page },
        createElement("div", { style: S.section }, "登录"),
        createElement(AuthPanel, { ctx: props.ctx, mount: props.mount }),
        createElement("div", { style: S.divider }),
        forms === undefined
          ? createElement("div", { style: S.warn }, "宿主没有提供配置服务（configForms），工具暴露设置不可用。")
          : createElement(ExposurePanel, { forms: forms }),
      );
    }

    // ---- apply ------------------------------------------------------------
    /**
     * 只注册一个「插件设置」页签。apply 必须同步且不抛异常：client 插件的 apply
     * 一旦失败会让整个 Web 启动失败（web boot: N entry did not activate），桌面端
     * 还会回滚第三方 bundle。挂载失败因此只在面板里显示。
     * @param ctx - 插件上下文。
     * @returns 槽位注册的清理函数。
     */
    function apply(ctx) {
      var mounting = null;
      function mount() {
        if (mounting === null) {
          mounting = Promise.resolve()
            .then(function () { return ctx.remote.$mount(CONTRIBUTION); })
            .then(
              function () { return null; },
              function (error) {
                console.error("dsh-hosted-tools: 挂载 Remote 命名空间失败", error);
                return errorMessage(error);
              },
            );
        }
        return mounting;
      }

      return ctx.slots.inject("settings.plugins.tab", function () {
        return ctx.slots.register(
          { name: "settings.plugins.tab", id: "hosted-tools", order: 30, label: "托管工具" },
          function () { return createElement(HostedToolsPanel, { ctx: ctx, mount: mount }); },
        );
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
