// Generated from protocol/openengine-cluster/v1/schema.json. Do not edit.
export const CLUSTER_PROTOCOL_SCHEMA: unknown = JSON.parse(
  "{\"$defs\":{\"ActiveExecution\":{\"additionalProperties\":false,\"description\":" +
  "\"One currently active graph-leaf execution.\\n\\n`execution` is the stable" +
  " selector used by logs and attach. `node` is the graph-visible\\nidentity" +
  " that makes multiple simultaneous verifier executions obvious to a clien" +
  "t.\",\"properties\":{\"execution\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"" +
  "^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"},\"node\":{\"maxLengt" +
  "h\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"stri" +
  "ng\"}},\"required\":[\"execution\",\"node\"],\"type\":\"object\"},\"AdmissionTransit" +
  "ion\":{\"additionalProperties\":false,\"properties\":{\"runId\":{\"type\":\"string" +
  "\"},\"seedInput\":true,\"spec\":{\"$ref\":\"#/$defs/GraphSpec\"}},\"required\":[\"ru" +
  "nId\",\"spec\",\"seedInput\"],\"type\":\"object\"},\"AgentAttachClosedNotification" +
  "\":{\"additionalProperties\":false,\"description\":\"Wire body of the terminal" +
  " `subscription/closed` server notification for an `agent/attach`\\nsubscr" +
  "iption. Deliberately carries no cursor field -- `agent/attach` gives a t" +
  "ype-level\\n\\\"cursorless\\\" guarantee, unlike [`crate::SubscriptionClosedN" +
  "otification`].\",\"properties\":{\"reason\":{\"$ref\":\"#/$defs/SubscriptionClos" +
  "eReason\"},\"subscriptionId\":{\"type\":\"string\"}},\"required\":[\"subscriptionI" +
  "d\",\"reason\"],\"type\":\"object\"},\"AgentAttachEvent\":{\"description\":\"The clo" +
  "sed public agent-attach progress algebra. This is the only representable" +
  " shape:\\nreasoning, tools, provider frames, usage, and session identifie" +
  "rs have no variant. `Working`\\nand `Settled` are empty struct variants r" +
  "ather than bare units: serde's internally tagged enum\\ndeserialization s" +
  "ilently ignores unknown fields on a unit variant regardless of\\n`deny_un" +
  "known_fields`, which would otherwise let an unrepresentable field ride a" +
  "long\\nundetected on either of these two variants.\",\"oneOf\":[{\"additional" +
  "Properties\":false,\"properties\":{\"type\":{\"const\":\"working\",\"type\":\"string" +
  "\"}},\"required\":[\"type\"],\"type\":\"object\"},{\"additionalProperties\":false,\"" +
  "properties\":{\"text\":{\"maxLength\":16384,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u0" +
  "07f-\\\\u009f]*$\",\"type\":\"string\"},\"type\":{\"const\":\"output\",\"type\":\"string" +
  "\"}},\"required\":[\"type\",\"text\"],\"type\":\"object\"},{\"additionalProperties\":" +
  "false,\"properties\":{\"type\":{\"const\":\"settled\",\"type\":\"string\"}},\"require" +
  "d\":[\"type\"],\"type\":\"object\"}]},\"AgentAttachEventNotification\":{\"$ref\":\"#" +
  "/$defs/AgentAttachEventNotificationWire\"},\"AgentAttachEventNotificationW" +
  "ire\":{\"additionalProperties\":false,\"properties\":{\"event\":{\"$ref\":\"#/$def" +
  "s/AgentAttachEvent\"},\"subscriptionId\":{\"type\":\"string\"}},\"required\":[\"su" +
  "bscriptionId\",\"event\"],\"type\":\"object\"},\"AgentAttachParams\":{\"additional" +
  "Properties\":false,\"description\":\"`agent/attach` establishment parameters" +
  ": the named `{execution}` request. Deliberately closed,\\nrejecting any u" +
  "nknown field.\",\"properties\":{\"execution\":{\"maxLength\":128,\"minLength\":1," +
  "\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"}},\"requ" +
  "ired\":[\"execution\"],\"type\":\"object\"},\"AgentAttachResult\":{\"additionalPro" +
  "perties\":false,\"description\":\"The `agent/attach` establishment result: o" +
  "nly a `subscriptionId`. Deliberately carries no\\n`runId` or `atCursor` -" +
  "- `agent/attach` is not run-scoped and has no cursor.\",\"properties\":{\"su" +
  "bscriptionId\":{\"type\":\"string\"}},\"required\":[\"subscriptionId\"],\"type\":\"o" +
  "bject\"},\"ApplyParams\":{\"additionalProperties\":false,\"properties\":{\"dryRu" +
  "n\":{\"default\":false,\"type\":\"boolean\"},\"graph\":{\"$ref\":\"#/$defs/GraphSpec" +
  "\"},\"idempotencyKey\":{\"maxLength\":256,\"minLength\":1,\"pattern\":\"^[^\\\\u0000" +
  "-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"},\"ifGeneration\":{\"maximum\":9" +
  "007199254740991,\"minimum\":0,\"type\":\"integer\"},\"input\":true},\"required\":[" +
  "\"graph\"],\"type\":\"object\"},\"ApplyResult\":{\"additionalProperties\":false,\"p" +
  "roperties\":{\"deduped\":{\"type\":\"boolean\"},\"diff\":{\"anyOf\":[{\"$ref\":\"#/$de" +
  "fs/GraphDiff\"},{\"type\":\"null\"}]},\"generation\":{\"maximum\":900719925474099" +
  "1,\"minimum\":0,\"type\":[\"integer\",\"null\"]},\"phase\":{\"$ref\":\"#/$defs/Phase\"" +
  "},\"runId\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"phase\",\"deduped\"],\"ty" +
  "pe\":\"object\"},\"ArtifactLineage\":{\"additionalProperties\":false,\"propertie" +
  "s\":{\"attempt\":{\"maximum\":9007199254740991,\"minimum\":1,\"type\":\"integer\"}," +
  "\"generation\":{\"maximum\":9007199254740991,\"minimum\":0,\"type\":\"integer\"},\"" +
  "runId\":{\"type\":\"string\"}},\"required\":[\"generation\",\"runId\",\"attempt\"],\"t" +
  "ype\":\"object\"},\"ArtifactProducer\":{\"additionalProperties\":false,\"propert" +
  "ies\":{\"node\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z" +
  "0-9_.-]*$\",\"type\":\"string\"},\"worker\":{\"maxLength\":256,\"pattern\":\"^[A-Za-" +
  "z_][A-Za-z0-9_.-]*@[1-9][0-9]*$\",\"type\":\"string\"}},\"required\":[\"node\",\"w" +
  "orker\"],\"type\":\"object\"},\"ArtifactRef\":{\"additionalProperties\":false,\"pr" +
  "operties\":{\"artifactId\":{\"maxLength\":256,\"minLength\":1,\"pattern\":\"^[^\\\\u" +
  "0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"},\"byteLength\":{\"maximum\"" +
  ":9007199254740991,\"minimum\":0,\"type\":\"integer\"},\"lineage\":{\"$ref\":\"#/$de" +
  "fs/ArtifactLineage\"},\"mediaType\":{\"maxLength\":256,\"minLength\":1,\"pattern" +
  "\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"},\"producer\":{\"$" +
  "ref\":\"#/$defs/ArtifactProducer\"},\"redaction\":{\"$ref\":\"#/$defs/RedactionC" +
  "lass\"},\"sha256\":{\"pattern\":\"^[0-9a-f]{64}$\",\"type\":\"string\"},\"typeId\":{\"" +
  "maxLength\":256,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*@[1-9][0-9]*$\",\"type\"" +
  ":\"string\"}},\"required\":[\"artifactId\",\"sha256\",\"byteLength\",\"mediaType\",\"" +
  "typeId\",\"producer\",\"lineage\",\"redaction\"],\"type\":\"object\"},\"BackendFault" +
  "\":{\"$ref\":\"#/$defs/BackendFaultWire\"},\"BackendFaultWire\":{\"additionalPro" +
  "perties\":false,\"properties\":{\"action\":{\"$ref\":\"#/$defs/FaultAction\"},\"co" +
  "de\":{\"$ref\":\"#/$defs/FaultCode\"},\"consequence\":{\"$ref\":\"#/$defs/FaultCon" +
  "sequence\"},\"eventId\":{\"maxLength\":256,\"minLength\":1,\"pattern\":\"^[^\\\\u000" +
  "0-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"},\"executionRef\":{\"default\":" +
  "null,\"maxLength\":256,\"minLength\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-" +
  "\\\\u009f]+$\",\"type\":[\"string\",\"null\"]},\"retry\":{\"$ref\":\"#/$defs/FaultRetr" +
  "yDisposition\"},\"severity\":{\"$ref\":\"#/$defs/FaultSeverity\"},\"source\":{\"it" +
  "ems\":{\"$ref\":\"#/$defs/FaultSourceFrame\"},\"maxItems\":8,\"type\":\"array\"},\"s" +
  "ummary\":{\"maxLength\":256,\"minLength\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u0" +
  "07f-\\\\u009f]+$\",\"type\":\"string\"}},\"required\":[\"eventId\",\"code\",\"conseque" +
  "nce\",\"retry\",\"action\",\"severity\",\"summary\",\"source\"],\"type\":\"object\"},\"C" +
  "ancelRequestParams\":{\"additionalProperties\":false,\"description\":\"Wire bo" +
  "dy of the `$/cancelRequest` client notification: best-effort cancellatio" +
  "n of an\\nin-flight unary request by its `RequestId`. Unknown or already-" +
  "completed ids are a silent\\nno-op; cancelling after the backend has comm" +
  "itted leaves that committed state unchanged and\\nemits no response or co" +
  "mpensation.\",\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"}},\"required\"" +
  ":[\"id\"],\"type\":\"object\"},\"ChoiceBranch\":{\"additionalProperties\":false,\"p" +
  "roperties\":{\"node\":{\"$ref\":\"#/$defs/GraphNode\"},\"when\":{\"$ref\":\"#/$defs/" +
  "Guard\"}},\"required\":[\"when\",\"node\"],\"type\":\"object\"},\"ClaudeProvider\":{\"" +
  "enum\":[\"anthropic\",\"openrouter\"],\"type\":\"string\"},\"ClusterStatus\":{\"prop" +
  "erties\":{\"atCursor\":{\"type\":[\"string\",\"null\"]},\"currentRunId\":{\"type\":[\"" +
  "string\",\"null\"]},\"observedGeneration\":{\"maximum\":9007199254740991,\"minim" +
  "um\":0,\"type\":[\"integer\",\"null\"]},\"operational\":{\"anyOf\":[{\"$ref\":\"#/$def" +
  "s/OperationalStatus\"},{\"type\":\"null\"}]},\"phase\":{\"$ref\":\"#/$defs/Phase\"}" +
  "},\"required\":[\"phase\"],\"type\":\"object\"},\"CodexProvider\":{\"enum\":[\"openai" +
  "\",\"openrouter\"],\"type\":\"string\"},\"ControlSelector\":{\"additionalPropertie" +
  "s\":false,\"properties\":{\"field\":{\"maxLength\":128,\"minLength\":1,\"pattern\":" +
  "\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":[\"string\",\"null\"]},\"name\":{\"maxLengt" +
  "h\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"stri" +
  "ng\"},\"source\":{\"$ref\":\"#/$defs/ControlSource\"}},\"required\":[\"name\",\"sour" +
  "ce\"],\"type\":\"object\"},\"ControlSource\":{\"enum\":[\"signal\",\"error\",\"group\"]" +
  ",\"type\":\"string\"},\"DataSelector\":{\"oneOf\":[{\"additionalProperties\":false" +
  ",\"properties\":{\"path\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pattern\":" +
  "\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"maxItems\":64,\"minItems\":1" +
  ",\"type\":\"array\"},\"source\":{\"const\":\"state\",\"type\":\"string\"}},\"required\":" +
  "[\"source\",\"path\"],\"type\":\"object\"},{\"additionalProperties\":false,\"proper" +
  "ties\":{\"path\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-" +
  "z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"maxItems\":64,\"minItems\":1,\"type\":" +
  "\"array\"},\"source\":{\"const\":\"item\",\"type\":\"string\"}},\"required\":[\"source\"" +
  ",\"path\"],\"type\":\"object\"}]},\"DeclaredConnections\":{\"additionalProperties" +
  "\":{\"$ref\":\"#/$defs/DeclaredEnvironment\"},\"maxProperties\":64,\"type\":\"obje" +
  "ct\"},\"DeclaredEnvironment\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"patt" +
  "ern\":\"^[A-Za-z_][A-Za-z0-9_]*$\",\"type\":\"string\"},\"maxItems\":64,\"type\":\"a" +
  "rray\",\"uniqueItems\":true},\"DeleteParams\":{\"additionalProperties\":false,\"" +
  "properties\":{\"idempotencyKey\":{\"maxLength\":256,\"minLength\":1,\"pattern\":\"" +
  "^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"},\"ifGeneration\":{\"" +
  "maximum\":9007199254740991,\"minimum\":0,\"type\":\"integer\"},\"ifRunId\":{\"type" +
  "\":[\"string\",\"null\"]}},\"required\":[\"ifGeneration\",\"idempotencyKey\"],\"type" +
  "\":\"object\"},\"DeleteResult\":{\"additionalProperties\":false,\"properties\":{\"" +
  "atCursor\":{\"type\":[\"string\",\"null\"]},\"deduped\":{\"type\":\"boolean\"},\"delet" +
  "ed\":{\"type\":\"boolean\"},\"generation\":{\"maximum\":9007199254740991,\"minimum" +
  "\":0,\"type\":[\"integer\",\"null\"]},\"phase\":{\"$ref\":\"#/$defs/Phase\"},\"runId\":" +
  "{\"type\":[\"string\",\"null\"]}},\"required\":[\"deleted\",\"phase\",\"deduped\"],\"ty" +
  "pe\":\"object\"},\"DiagnosticPathSegment\":{\"oneOf\":[{\"additionalProperties\":" +
  "false,\"properties\":{\"kind\":{\"const\":\"field\",\"type\":\"string\"},\"name\":{\"ma" +
  "xLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\"" +
  ":\"string\"}},\"required\":[\"kind\",\"name\"],\"type\":\"object\"},{\"additionalProp" +
  "erties\":false,\"properties\":{\"index\":{\"format\":\"uint32\",\"maximum\":4294967" +
  "295,\"minimum\":0,\"type\":\"integer\"},\"kind\":{\"const\":\"index\",\"type\":\"string" +
  "\"}},\"required\":[\"kind\",\"index\"],\"type\":\"object\"},{\"additionalProperties\"" +
  ":false,\"properties\":{\"kind\":{\"const\":\"node\",\"type\":\"string\"},\"name\":{\"ma" +
  "xLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\"" +
  ":\"string\"}},\"required\":[\"kind\",\"name\"],\"type\":\"object\"}]},\"DiagnosticSev" +
  "erity\":{\"enum\":[\"error\",\"warning\",\"info\"],\"type\":\"string\"},\"DispatchStat" +
  "e\":{\"enum\":[\"active\",\"suspended\",\"draining\",\"force_stopping\",\"stopped\"]," +
  "\"type\":\"string\"},\"DomainErrorData\":{\"properties\":{\"code\":{\"type\":\"string" +
  "\"},\"details\":true},\"required\":[\"code\"],\"type\":\"object\"},\"EventNotificati" +
  "on\":{\"additionalProperties\":false,\"description\":\"Wire body of the generi" +
  "c `event` server notification.\",\"properties\":{\"cursor\":{\"type\":\"string\"}" +
  ",\"event\":{\"$ref\":\"#/$defs/WatchEvent\"},\"runId\":{\"type\":\"string\"},\"subscr" +
  "iptionId\":{\"type\":\"string\"}},\"required\":[\"subscriptionId\",\"runId\",\"curso" +
  "r\",\"event\"],\"type\":\"object\"},\"FaultAction\":{\"description\":\"Descriptive o" +
  "nly, like [`FaultRetryDisposition`]: naming `Retry` never itself retries" +
  " or\\nauthorizes a retry.\",\"enum\":[\"none\",\"retry\",\"wait\",\"escalate\",\"abor" +
  "t\"],\"type\":\"string\"},\"FaultCode\":{\"enum\":[\"unavailable\",\"resource_exhaus" +
  "ted\",\"deadline_exceeded\",\"permission_denied\",\"failed_precondition\",\"not_" +
  "found\",\"aborted\",\"internal\",\"unknown\"],\"type\":\"string\"},\"FaultConsequenc" +
  "e\":{\"enum\":[\"turn_failed\",\"run_failed\",\"run_degraded\",\"no_observable_eff" +
  "ect\"],\"type\":\"string\"},\"FaultRetryDisposition\":{\"description\":\"Descripti" +
  "ve only: no `BackendFault` and no `fault` event ever performs or authori" +
  "zes a retry.\\nEvent ordering and emission never themselves change termin" +
  "al semantics.\",\"enum\":[\"retryable\",\"retryable_after_backoff\",\"not_retrya" +
  "ble\",\"indeterminate\"],\"type\":\"string\"},\"FaultSeverity\":{\"enum\":[\"info\",\"" +
  "warning\",\"error\",\"critical\"],\"type\":\"string\"},\"FaultSourceFrame\":{\"addit" +
  "ionalProperties\":false,\"properties\":{\"component\":{\"maxLength\":256,\"minLe" +
  "ngth\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"" +
  "}},\"required\":[\"component\"],\"type\":\"object\"},\"GetParams\":{\"additionalPro" +
  "perties\":false,\"properties\":{\"atCursor\":{\"default\":null,\"type\":[\"string\"" +
  ",\"null\"]}},\"type\":\"object\"},\"GetResult\":{\"properties\":{\"atCursor\":{\"type" +
  "\":[\"string\",\"null\"]},\"spec\":{\"anyOf\":[{\"$ref\":\"#/$defs/GraphSpec\"},{\"typ" +
  "e\":\"null\"}]},\"status\":{\"$ref\":\"#/$defs/ClusterStatus\"},\"terminalResult\":" +
  "{\"anyOf\":[{\"$ref\":\"#/$defs/TerminalResult\"},{\"type\":\"null\"}]}},\"required" +
  "\":[\"status\"],\"type\":\"object\"},\"GraphDiagnostic\":{\"additionalProperties\":" +
  "false,\"properties\":{\"code\":{\"$ref\":\"#/$defs/GraphDiagnosticCode\"},\"messa" +
  "ge\":{\"type\":\"string\"},\"path\":{\"items\":{\"$ref\":\"#/$defs/DiagnosticPathSeg" +
  "ment\"},\"type\":\"array\"},\"relatedNodes\":{\"items\":{\"maxLength\":128,\"minLeng" +
  "th\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"type\":\"ar" +
  "ray\"},\"severity\":{\"$ref\":\"#/$defs/DiagnosticSeverity\"}},\"required\":[\"sev" +
  "erity\",\"code\",\"message\",\"path\",\"relatedNodes\"],\"type\":\"object\"},\"GraphDi" +
  "agnosticCode\":{\"enum\":[\"schema_safety\",\"reachability\",\"choice_exhaustive" +
  "ness\",\"loop_exit_satisfiability\",\"missing_bound\",\"write_conflict\",\"ceili" +
  "ng_exceeded\",\"cyclic_reference\",\"undefined_read\",\"invalid_graph_shape\"]," +
  "\"type\":\"string\"},\"GraphDiff\":{\"additionalProperties\":false,\"properties\":" +
  "{\"added\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A" +
  "-Za-z0-9_.-]*$\",\"type\":\"string\"},\"type\":\"array\"},\"changed\":{\"items\":{\"ma" +
  "xLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\"" +
  ":\"string\"},\"type\":\"array\"},\"removed\":{\"items\":{\"maxLength\":128,\"minLengt" +
  "h\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"type\":\"arr" +
  "ay\"}},\"required\":[\"added\",\"removed\",\"changed\"],\"type\":\"object\"},\"GraphNo" +
  "de\":{\"oneOf\":[{\"additionalProperties\":false,\"properties\":{\"attempts\":{\"m" +
  "aximum\":9007199254740991,\"minimum\":1,\"type\":\"integer\"},\"input\":{\"$ref\":\"" +
  "#/$defs/PayloadType\"},\"inputBindings\":{\"items\":{\"$ref\":\"#/$defs/InputBin" +
  "ding\"},\"type\":\"array\"},\"instructions\":{\"anyOf\":[{\"$ref\":\"#/$defs/NodeIns" +
  "tructions\"},{\"type\":\"null\"}]},\"kind\":{\"const\":\"step\",\"type\":\"string\"},\"n" +
  "ame\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*" +
  "$\",\"type\":\"string\"},\"output\":{\"$ref\":\"#/$defs/PayloadType\"},\"timeoutMs\":" +
  "{\"maximum\":9007199254740991,\"minimum\":1,\"type\":\"integer\"},\"worker\":{\"max" +
  "Length\":256,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*@[1-9][0-9]*$\",\"type\":\"s" +
  "tring\"},\"writeBindings\":{\"items\":{\"$ref\":\"#/$defs/WriteBinding\"},\"type\":" +
  "\"array\"}},\"required\":[\"kind\",\"name\",\"worker\",\"input\",\"output\",\"inputBind" +
  "ings\",\"writeBindings\",\"timeoutMs\",\"attempts\"],\"type\":\"object\"},{\"additio" +
  "nalProperties\":false,\"properties\":{\"attempts\":{\"maximum\":900719925474099" +
  "1,\"minimum\":1,\"type\":\"integer\"},\"diagnostic\":{\"$ref\":\"#/$defs/PayloadTyp" +
  "e\"},\"input\":{\"$ref\":\"#/$defs/PayloadType\"},\"inputBindings\":{\"items\":{\"$r" +
  "ef\":\"#/$defs/InputBinding\"},\"type\":\"array\"},\"instructions\":{\"anyOf\":[{\"$" +
  "ref\":\"#/$defs/NodeInstructions\"},{\"type\":\"null\"}]},\"kind\":{\"const\":\"veri" +
  "fier\",\"type\":\"string\"},\"name\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"" +
  "^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"output\":{\"$ref\":\"#/$defs/P" +
  "ayloadType\"},\"signals\":{\"additionalProperties\":{\"items\":{\"maxLength\":128" +
  ",\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"" +
  "maxItems\":4096,\"minItems\":1,\"type\":\"array\",\"uniqueItems\":true},\"property" +
  "Names\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-" +
  "]*$\",\"type\":\"string\"},\"type\":\"object\"},\"timeoutMs\":{\"maximum\":9007199254" +
  "740991,\"minimum\":1,\"type\":\"integer\"},\"worker\":{\"maxLength\":256,\"pattern\"" +
  ":\"^[A-Za-z_][A-Za-z0-9_.-]*@[1-9][0-9]*$\",\"type\":\"string\"},\"writeBinding" +
  "s\":{\"items\":{\"$ref\":\"#/$defs/WriteBinding\"},\"type\":\"array\"}},\"required\":" +
  "[\"kind\",\"name\",\"worker\",\"input\",\"output\",\"inputBindings\",\"writeBindings\"" +
  ",\"timeoutMs\",\"attempts\",\"signals\",\"diagnostic\"],\"type\":\"object\"},{\"addit" +
  "ionalProperties\":false,\"properties\":{\"children\":{\"$ref\":\"#/$defs/NonEmpt" +
  "yVec_of_GraphNode\"},\"kind\":{\"const\":\"seq\",\"type\":\"string\"},\"name\":{\"maxL" +
  "ength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"" +
  "string\"},\"promotedStatePaths\":{\"items\":{\"items\":{\"maxLength\":128,\"minLen" +
  "gth\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"maxItems" +
  "\":64,\"minItems\":1,\"type\":\"array\"},\"type\":\"array\"},\"state\":{\"$ref\":\"#/$de" +
  "fs/PayloadType\"}},\"required\":[\"kind\",\"name\",\"state\",\"children\",\"promoted" +
  "StatePaths\"],\"type\":\"object\"},{\"additionalProperties\":false,\"properties\"" +
  ":{\"branches\":{\"$ref\":\"#/$defs/NonEmptyVec_of_ChoiceBranch\"},\"kind\":{\"con" +
  "st\":\"choice\",\"type\":\"string\"},\"name\":{\"maxLength\":128,\"minLength\":1,\"pat" +
  "tern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"otherwise\":{\"anyOf\"" +
  ":[{\"$ref\":\"#/$defs/GraphNode\"},{\"type\":\"null\"}]},\"promotedStatePaths\":{\"" +
  "items\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Z" +
  "a-z0-9_.-]*$\",\"type\":\"string\"},\"maxItems\":64,\"minItems\":1,\"type\":\"array\"" +
  "},\"type\":\"array\"},\"state\":{\"$ref\":\"#/$defs/PayloadType\"}},\"required\":[\"k" +
  "ind\",\"name\",\"state\",\"branches\",\"promotedStatePaths\"],\"type\":\"object\"},{\"" +
  "additionalProperties\":false,\"properties\":{\"branches\":{\"$ref\":\"#/$defs/No" +
  "nEmptyVec_of_GraphNode\"},\"join\":{\"$ref\":\"#/$defs/Join\"},\"kind\":{\"const\":" +
  "\"par\",\"type\":\"string\"},\"name\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"" +
  "^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"promotedStatePaths\":{\"item" +
  "s\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0" +
  "-9_.-]*$\",\"type\":\"string\"},\"maxItems\":64,\"minItems\":1,\"type\":\"array\"},\"t" +
  "ype\":\"array\"},\"state\":{\"$ref\":\"#/$defs/PayloadType\"}},\"required\":[\"kind\"" +
  ",\"name\",\"state\",\"branches\",\"promotedStatePaths\",\"join\"],\"type\":\"object\"}" +
  ",{\"additionalProperties\":false,\"properties\":{\"body\":{\"$ref\":\"#/$defs/Gra" +
  "phNode\"},\"kind\":{\"const\":\"loop\",\"type\":\"string\"},\"maxIterations\":{\"maxim" +
  "um\":9007199254740991,\"minimum\":1,\"type\":\"integer\"},\"name\":{\"maxLength\":1" +
  "28,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"}" +
  ",\"promotedStatePaths\":{\"items\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"" +
  "pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"maxItems\":64,\"mi" +
  "nItems\":1,\"type\":\"array\"},\"type\":\"array\"},\"state\":{\"$ref\":\"#/$defs/Paylo" +
  "adType\"},\"until\":{\"anyOf\":[{\"$ref\":\"#/$defs/Guard\"},{\"type\":\"null\"}]}},\"" +
  "required\":[\"kind\",\"name\",\"state\",\"body\",\"maxIterations\",\"promotedStatePa" +
  "ths\"],\"type\":\"object\"},{\"additionalProperties\":false,\"properties\":{\"body" +
  "\":{\"$ref\":\"#/$defs/GraphNode\"},\"kind\":{\"const\":\"map\",\"type\":\"string\"},\"m" +
  "axItems\":{\"maximum\":9007199254740991,\"minimum\":1,\"type\":\"integer\"},\"name" +
  "\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\"," +
  "\"type\":\"string\"},\"over\":{\"$ref\":\"#/$defs/DataSelector\"},\"promotedStatePa" +
  "ths\":{\"items\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-" +
  "z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"maxItems\":64,\"minItems\":1,\"type\":" +
  "\"array\"},\"type\":\"array\"},\"state\":{\"$ref\":\"#/$defs/PayloadType\"}},\"requir" +
  "ed\":[\"kind\",\"name\",\"state\",\"body\",\"over\",\"maxItems\",\"promotedStatePaths\"" +
  "],\"type\":\"object\"},{\"additionalProperties\":false,\"properties\":{\"bindings" +
  "\":{\"items\":{\"$ref\":\"#/$defs/InputBinding\"},\"type\":\"array\"},\"kind\":{\"cons" +
  "t\":\"succeed\",\"type\":\"string\"},\"name\":{\"maxLength\":128,\"minLength\":1,\"pat" +
  "tern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"output\":{\"$ref\":\"#/" +
  "$defs/PayloadType\"}},\"required\":[\"kind\",\"name\",\"output\",\"bindings\"],\"typ" +
  "e\":\"object\"},{\"additionalProperties\":false,\"properties\":{\"kind\":{\"const\"" +
  ":\"fail\",\"type\":\"string\"},\"name\":{\"maxLength\":128,\"minLength\":1,\"pattern\"" +
  ":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"reason\":{\"maxLength\":128" +
  ",\"minLength\":1,\"pattern\":\"^(?!unhandled$)[A-Za-z_][A-Za-z0-9_.-]*$\",\"typ" +
  "e\":\"string\"}},\"required\":[\"kind\",\"name\",\"reason\"],\"type\":\"object\"}]},\"Gr" +
  "aphProfile\":{\"enum\":[\"openengine.graph.full/v1\",\"openengine.graph.single" +
  "-worker/v1\"],\"type\":\"string\"},\"GraphSpec\":{\"additionalProperties\":false," +
  "\"properties\":{\"initialInput\":{\"$ref\":\"#/$defs/PayloadType\"},\"policy\":{\"$" +
  "ref\":\"#/$defs/PolicyBinding\"},\"profile\":{\"$ref\":\"#/$defs/GraphProfile\"}," +
  "\"root\":{\"$ref\":\"#/$defs/GraphNode\"}},\"required\":[\"profile\",\"initialInput" +
  "\",\"policy\",\"root\"],\"type\":\"object\"},\"Guard\":{\"oneOf\":[{\"additionalProper" +
  "ties\":false,\"properties\":{\"kind\":{\"const\":\"in\",\"type\":\"string\"},\"labels\"" +
  ":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9" +
  "_.-]*$\",\"type\":\"string\"},\"maxItems\":4096,\"minItems\":1,\"type\":\"array\",\"un" +
  "iqueItems\":true},\"value\":{\"$ref\":\"#/$defs/ControlSelector\"}},\"required\":" +
  "[\"kind\",\"value\",\"labels\"],\"type\":\"object\"},{\"additionalProperties\":false" +
  ",\"properties\":{\"guards\":{\"$ref\":\"#/$defs/NonEmptyVec_of_Guard\"},\"kind\":{" +
  "\"const\":\"all\",\"type\":\"string\"}},\"required\":[\"kind\",\"guards\"],\"type\":\"obj" +
  "ect\"},{\"additionalProperties\":false,\"properties\":{\"guards\":{\"$ref\":\"#/$d" +
  "efs/NonEmptyVec_of_Guard\"},\"kind\":{\"const\":\"any\",\"type\":\"string\"}},\"requ" +
  "ired\":[\"kind\",\"guards\"],\"type\":\"object\"},{\"additionalProperties\":false,\"" +
  "properties\":{\"guard\":{\"$ref\":\"#/$defs/Guard\"},\"kind\":{\"const\":\"not\",\"typ" +
  "e\":\"string\"}},\"required\":[\"kind\",\"guard\"],\"type\":\"object\"},{\"additionalP" +
  "roperties\":false,\"properties\":{\"count\":{\"maximum\":9007199254740991,\"mini" +
  "mum\":1,\"type\":\"integer\"},\"kind\":{\"const\":\"k_of_n\",\"type\":\"string\"},\"labe" +
  "ls\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z" +
  "0-9_.-]*$\",\"type\":\"string\"},\"maxItems\":4096,\"minItems\":1,\"type\":\"array\"," +
  "\"uniqueItems\":true},\"values\":{\"$ref\":\"#/$defs/NonEmptyVec_of_ControlSele" +
  "ctor\"}},\"required\":[\"kind\",\"count\",\"values\",\"labels\"],\"type\":\"object\"},{" +
  "\"additionalProperties\":false,\"properties\":{\"count\":{\"maximum\":9007199254" +
  "740991,\"minimum\":1,\"type\":\"integer\"},\"kind\":{\"const\":\"k_of_map\",\"type\":\"" +
  "string\"},\"labels\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A" +
  "-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"maxItems\":4096,\"minItems\":1,\"" +
  "type\":\"array\",\"uniqueItems\":true},\"value\":{\"$ref\":\"#/$defs/ControlSelect" +
  "or\"}},\"required\":[\"kind\",\"count\",\"value\",\"labels\"],\"type\":\"object\"}]},\"I" +
  "nitializeParams\":{\"additionalProperties\":false,\"properties\":{\"protocolVe" +
  "rsion\":{\"const\":\"openengine.cluster/v1\",\"type\":\"string\"}},\"required\":[\"p" +
  "rotocolVersion\"],\"type\":\"object\"},\"InitializeResult\":{\"properties\":{\"cap" +
  "abilities\":{\"$ref\":\"#/$defs/ServerCapabilities\"},\"protocolVersion\":{\"con" +
  "st\":\"openengine.cluster/v1\",\"type\":\"string\"},\"status\":{\"$ref\":\"#/$defs/C" +
  "lusterStatus\"}},\"required\":[\"protocolVersion\",\"capabilities\",\"status\"],\"" +
  "type\":\"object\"},\"InputBinding\":{\"additionalProperties\":false,\"properties" +
  "\":{\"target\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_" +
  "][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"maxItems\":64,\"minItems\":1,\"type\":\"a" +
  "rray\"},\"value\":{\"$ref\":\"#/$defs/DataSelector\"}},\"required\":[\"target\",\"va" +
  "lue\"],\"type\":\"object\"},\"Join\":{\"oneOf\":[{\"additionalProperties\":false,\"p" +
  "roperties\":{\"kind\":{\"const\":\"all\",\"type\":\"string\"}},\"required\":[\"kind\"]," +
  "\"type\":\"object\"},{\"additionalProperties\":false,\"properties\":{\"kind\":{\"co" +
  "nst\":\"any\",\"type\":\"string\"}},\"required\":[\"kind\"],\"type\":\"object\"},{\"addi" +
  "tionalProperties\":false,\"properties\":{\"count\":{\"maximum\":900719925474099" +
  "1,\"minimum\":1,\"type\":\"integer\"},\"kind\":{\"const\":\"quorum\",\"type\":\"string\"" +
  "}},\"required\":[\"kind\",\"count\"],\"type\":\"object\"},{\"additionalProperties\":" +
  "false,\"properties\":{\"kind\":{\"const\":\"first\",\"type\":\"string\"},\"when\":{\"$r" +
  "ef\":\"#/$defs/Guard\"}},\"required\":[\"kind\",\"when\"],\"type\":\"object\"}]},\"Jso" +
  "nRpcError\":{\"properties\":{\"code\":{\"format\":\"int64\",\"type\":\"integer\"},\"da" +
  "ta\":{\"anyOf\":[{\"$ref\":\"#/$defs/DomainErrorData\"},{\"type\":\"null\"}]},\"mess" +
  "age\":{\"type\":\"string\"}},\"required\":[\"code\",\"message\"],\"type\":\"object\"},\"" +
  "JsonRpcErrorResponse\":{\"properties\":{\"error\":{\"$ref\":\"#/$defs/JsonRpcErr" +
  "or\"},\"id\":{\"anyOf\":[{\"$ref\":\"#/$defs/RequestId\"},{\"type\":\"null\"}]},\"json" +
  "rpc\":{\"type\":\"string\"}},\"required\":[\"jsonrpc\",\"error\"],\"type\":\"object\"}," +
  "\"JsonRpcNotification\":{\"properties\":{\"jsonrpc\":{\"type\":\"string\"},\"method" +
  "\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/EventNotification\"}},\"requ" +
  "ired\":[\"jsonrpc\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcNotificatio" +
  "n10\":{\"properties\":{\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string" +
  "\"},\"params\":{\"$ref\":\"#/$defs/RunLogEventNotification\"}},\"required\":[\"jso" +
  "nrpc\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcNotification11\":{\"prop" +
  "erties\":{\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"params\"" +
  ":{\"$ref\":\"#/$defs/RunAttachEventNotification\"}},\"required\":[\"jsonrpc\",\"m" +
  "ethod\",\"params\"],\"type\":\"object\"},\"JsonRpcNotification2\":{\"properties\":{" +
  "\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":" +
  "\"#/$defs/SubscriptionCancelParams\"}},\"required\":[\"jsonrpc\",\"method\",\"par" +
  "ams\"],\"type\":\"object\"},\"JsonRpcNotification3\":{\"properties\":{\"jsonrpc\":{" +
  "\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/Su" +
  "bscriptionClosedNotification\"}},\"required\":[\"jsonrpc\",\"method\",\"params\"]" +
  ",\"type\":\"object\"},\"JsonRpcNotification4\":{\"properties\":{\"jsonrpc\":{\"type" +
  "\":\"string\"},\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/CancelR" +
  "equestParams\"}},\"required\":[\"jsonrpc\",\"method\",\"params\"],\"type\":\"object\"" +
  "},\"JsonRpcNotification5\":{\"properties\":{\"jsonrpc\":{\"type\":\"string\"},\"met" +
  "hod\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/LogEventNotification\"}}" +
  ",\"required\":[\"jsonrpc\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcNotif" +
  "ication6\":{\"properties\":{\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"s" +
  "tring\"},\"params\":{\"$ref\":\"#/$defs/LogsClosedNotification\"}},\"required\":[" +
  "\"jsonrpc\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcNotification7\":{\"p" +
  "roperties\":{\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"para" +
  "ms\":{\"$ref\":\"#/$defs/AgentAttachEventNotification\"}},\"required\":[\"jsonrp" +
  "c\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcNotification8\":{\"properti" +
  "es\":{\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"params\":{\"$" +
  "ref\":\"#/$defs/AgentAttachClosedNotification\"}},\"required\":[\"jsonrpc\",\"me" +
  "thod\",\"params\"],\"type\":\"object\"},\"JsonRpcNotification9\":{\"properties\":{\"" +
  "jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":\"" +
  "#/$defs/RunWatchEventNotification\"}},\"required\":[\"jsonrpc\",\"method\",\"par" +
  "ams\"],\"type\":\"object\"},\"JsonRpcRequest\":{\"properties\":{\"id\":{\"$ref\":\"#/$" +
  "defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"}," +
  "\"params\":{\"$ref\":\"#/$defs/InitializeParams\"}},\"required\":[\"jsonrpc\",\"id\"" +
  ",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcRequest10\":{\"properties\":{\"" +
  "id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"" +
  "type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/WatchParams\"}},\"required\":[\"js" +
  "onrpc\",\"id\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcRequest11\":{\"pro" +
  "perties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"}," +
  "\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/LogsParams\"}},\"requ" +
  "ired\":[\"jsonrpc\",\"id\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcReques" +
  "t12\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":" +
  "\"string\"},\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/AgentAtta" +
  "chParams\"}},\"required\":[\"jsonrpc\",\"id\",\"method\",\"params\"],\"type\":\"object" +
  "\"},\"JsonRpcRequest13\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"" +
  "jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":\"" +
  "#/$defs/RunSubmitParams\"}},\"required\":[\"jsonrpc\",\"id\",\"method\",\"params\"]" +
  ",\"type\":\"object\"},\"JsonRpcRequest14\":{\"properties\":{\"id\":{\"$ref\":\"#/$def" +
  "s/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"pa" +
  "rams\":{\"$ref\":\"#/$defs/RunListParams\"}},\"required\":[\"jsonrpc\",\"id\",\"meth" +
  "od\",\"params\"],\"type\":\"object\"},\"JsonRpcRequest15\":{\"properties\":{\"id\":{\"" +
  "$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":" +
  "\"string\"},\"params\":{\"$ref\":\"#/$defs/RunStatusParams\"}},\"required\":[\"json" +
  "rpc\",\"id\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcRequest16\":{\"prope" +
  "rties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"m" +
  "ethod\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/RunWatchParams\"}},\"re" +
  "quired\":[\"jsonrpc\",\"id\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcRequ" +
  "est17\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type" +
  "\":\"string\"},\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/RunLogs" +
  "Params\"}},\"required\":[\"jsonrpc\",\"id\",\"method\",\"params\"],\"type\":\"object\"}" +
  ",\"JsonRpcRequest18\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"js" +
  "onrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/" +
  "$defs/RunAttachParams\"}},\"required\":[\"jsonrpc\",\"id\",\"method\",\"params\"],\"" +
  "type\":\"object\"},\"JsonRpcRequest19\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/" +
  "RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"para" +
  "ms\":{\"$ref\":\"#/$defs/RunForceParams\"}},\"required\":[\"jsonrpc\",\"id\",\"metho" +
  "d\",\"params\"],\"type\":\"object\"},\"JsonRpcRequest2\":{\"properties\":{\"id\":{\"$r" +
  "ef\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"s" +
  "tring\"},\"params\":{\"$ref\":\"#/$defs/PlanParams\"}},\"required\":[\"jsonrpc\",\"i" +
  "d\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcRequest3\":{\"properties\":{" +
  "\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"method\":{" +
  "\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/ApplyParams\"}},\"required\":[\"j" +
  "sonrpc\",\"id\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcRequest4\":{\"pro" +
  "perties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"}," +
  "\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/GetParams\"}},\"requi" +
  "red\":[\"jsonrpc\",\"id\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcRequest" +
  "5\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"s" +
  "tring\"},\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/UpdateParam" +
  "s\"}},\"required\":[\"jsonrpc\",\"id\",\"method\",\"params\"],\"type\":\"object\"},\"Jso" +
  "nRpcRequest6\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\"" +
  ":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":\"#/$defs/" +
  "StopParams\"}},\"required\":[\"jsonrpc\",\"id\",\"method\",\"params\"],\"type\":\"obje" +
  "ct\"},\"JsonRpcRequest7\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"}," +
  "\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"params\":{\"$ref\":" +
  "\"#/$defs/RetryParams\"}},\"required\":[\"jsonrpc\",\"id\",\"method\",\"params\"],\"t" +
  "ype\":\"object\"},\"JsonRpcRequest8\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/Re" +
  "questId\"},\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"string\"},\"params" +
  "\":{\"$ref\":\"#/$defs/ResubmitParams\"}},\"required\":[\"jsonrpc\",\"id\",\"method\"" +
  ",\"params\"],\"type\":\"object\"},\"JsonRpcRequest9\":{\"properties\":{\"id\":{\"$ref" +
  "\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"method\":{\"type\":\"str" +
  "ing\"},\"params\":{\"$ref\":\"#/$defs/DeleteParams\"}},\"required\":[\"jsonrpc\",\"i" +
  "d\",\"method\",\"params\"],\"type\":\"object\"},\"JsonRpcResponse\":{\"anyOf\":[{\"$re" +
  "f\":\"#/$defs/JsonRpcSuccess\"},{\"$ref\":\"#/$defs/JsonRpcErrorResponse\"}]},\"" +
  "JsonRpcResponse10\":{\"anyOf\":[{\"$ref\":\"#/$defs/JsonRpcSuccess10\"},{\"$ref\"" +
  ":\"#/$defs/JsonRpcErrorResponse\"}]},\"JsonRpcResponse11\":{\"anyOf\":[{\"$ref\"" +
  ":\"#/$defs/JsonRpcSuccess11\"},{\"$ref\":\"#/$defs/JsonRpcErrorResponse\"}]},\"" +
  "JsonRpcResponse12\":{\"anyOf\":[{\"$ref\":\"#/$defs/JsonRpcSuccess12\"},{\"$ref\"" +
  ":\"#/$defs/JsonRpcErrorResponse\"}]},\"JsonRpcResponse13\":{\"anyOf\":[{\"$ref\"" +
  ":\"#/$defs/JsonRpcSuccess13\"},{\"$ref\":\"#/$defs/JsonRpcErrorResponse\"}]},\"" +
  "JsonRpcResponse14\":{\"anyOf\":[{\"$ref\":\"#/$defs/JsonRpcSuccess14\"},{\"$ref\"" +
  ":\"#/$defs/JsonRpcErrorResponse\"}]},\"JsonRpcResponse15\":{\"anyOf\":[{\"$ref\"" +
  ":\"#/$defs/JsonRpcSuccess15\"},{\"$ref\":\"#/$defs/JsonRpcErrorResponse\"}]},\"" +
  "JsonRpcResponse16\":{\"anyOf\":[{\"$ref\":\"#/$defs/JsonRpcSuccess16\"},{\"$ref\"" +
  ":\"#/$defs/JsonRpcErrorResponse\"}]},\"JsonRpcResponse17\":{\"anyOf\":[{\"$ref\"" +
  ":\"#/$defs/JsonRpcSuccess17\"},{\"$ref\":\"#/$defs/JsonRpcErrorResponse\"}]},\"" +
  "JsonRpcResponse18\":{\"anyOf\":[{\"$ref\":\"#/$defs/JsonRpcSuccess18\"},{\"$ref\"" +
  ":\"#/$defs/JsonRpcErrorResponse\"}]},\"JsonRpcResponse19\":{\"anyOf\":[{\"$ref\"" +
  ":\"#/$defs/JsonRpcSuccess19\"},{\"$ref\":\"#/$defs/JsonRpcErrorResponse\"}]},\"" +
  "JsonRpcResponse2\":{\"anyOf\":[{\"$ref\":\"#/$defs/JsonRpcSuccess2\"},{\"$ref\":\"" +
  "#/$defs/JsonRpcErrorResponse\"}]},\"JsonRpcResponse3\":{\"anyOf\":[{\"$ref\":\"#" +
  "/$defs/JsonRpcSuccess3\"},{\"$ref\":\"#/$defs/JsonRpcErrorResponse\"}]},\"Json" +
  "RpcResponse4\":{\"anyOf\":[{\"$ref\":\"#/$defs/JsonRpcSuccess4\"},{\"$ref\":\"#/$d" +
  "efs/JsonRpcErrorResponse\"}]},\"JsonRpcResponse5\":{\"anyOf\":[{\"$ref\":\"#/$de" +
  "fs/JsonRpcSuccess5\"},{\"$ref\":\"#/$defs/JsonRpcErrorResponse\"}]},\"JsonRpcR" +
  "esponse6\":{\"anyOf\":[{\"$ref\":\"#/$defs/JsonRpcSuccess6\"},{\"$ref\":\"#/$defs/" +
  "JsonRpcErrorResponse\"}]},\"JsonRpcResponse7\":{\"anyOf\":[{\"$ref\":\"#/$defs/J" +
  "sonRpcSuccess7\"},{\"$ref\":\"#/$defs/JsonRpcErrorResponse\"}]},\"JsonRpcRespo" +
  "nse8\":{\"anyOf\":[{\"$ref\":\"#/$defs/JsonRpcSuccess8\"},{\"$ref\":\"#/$defs/Json" +
  "RpcErrorResponse\"}]},\"JsonRpcResponse9\":{\"anyOf\":[{\"$ref\":\"#/$defs/JsonR" +
  "pcSuccess9\"},{\"$ref\":\"#/$defs/JsonRpcErrorResponse\"}]},\"JsonRpcSuccess\":" +
  "{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"stri" +
  "ng\"},\"result\":{\"$ref\":\"#/$defs/InitializeResult\"}},\"required\":[\"jsonrpc\"" +
  ",\"id\",\"result\"],\"type\":\"object\"},\"JsonRpcSuccess10\":{\"properties\":{\"id\":" +
  "{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"result\":{\"$ref" +
  "\":\"#/$defs/WatchResult\"}},\"required\":[\"jsonrpc\",\"id\",\"result\"],\"type\":\"o" +
  "bject\"},\"JsonRpcSuccess11\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestI" +
  "d\"},\"jsonrpc\":{\"type\":\"string\"},\"result\":{\"$ref\":\"#/$defs/LogsResult\"}}," +
  "\"required\":[\"jsonrpc\",\"id\",\"result\"],\"type\":\"object\"},\"JsonRpcSuccess12\"" +
  ":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"str" +
  "ing\"},\"result\":{\"$ref\":\"#/$defs/AgentAttachResult\"}},\"required\":[\"jsonrp" +
  "c\",\"id\",\"result\"],\"type\":\"object\"},\"JsonRpcSuccess13\":{\"properties\":{\"id" +
  "\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"result\":{\"$r" +
  "ef\":\"#/$defs/RunSubmitResult\"}},\"required\":[\"jsonrpc\",\"id\",\"result\"],\"ty" +
  "pe\":\"object\"},\"JsonRpcSuccess14\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/Re" +
  "questId\"},\"jsonrpc\":{\"type\":\"string\"},\"result\":{\"$ref\":\"#/$defs/RunListR" +
  "esult\"}},\"required\":[\"jsonrpc\",\"id\",\"result\"],\"type\":\"object\"},\"JsonRpcS" +
  "uccess15\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"t" +
  "ype\":\"string\"},\"result\":{\"$ref\":\"#/$defs/RunStatusResult\"}},\"required\":[" +
  "\"jsonrpc\",\"id\",\"result\"],\"type\":\"object\"},\"JsonRpcSuccess16\":{\"propertie" +
  "s\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"resul" +
  "t\":{\"$ref\":\"#/$defs/RunWatchResult\"}},\"required\":[\"jsonrpc\",\"id\",\"result" +
  "\"],\"type\":\"object\"},\"JsonRpcSuccess17\":{\"properties\":{\"id\":{\"$ref\":\"#/$d" +
  "efs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"result\":{\"$ref\":\"#/$defs/Ru" +
  "nLogsResult\"}},\"required\":[\"jsonrpc\",\"id\",\"result\"],\"type\":\"object\"},\"Js" +
  "onRpcSuccess18\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrp" +
  "c\":{\"type\":\"string\"},\"result\":{\"$ref\":\"#/$defs/RunAttachResult\"}},\"requi" +
  "red\":[\"jsonrpc\",\"id\",\"result\"],\"type\":\"object\"},\"JsonRpcSuccess19\":{\"pro" +
  "perties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"}," +
  "\"result\":{\"$ref\":\"#/$defs/RunForceResult\"}},\"required\":[\"jsonrpc\",\"id\",\"" +
  "result\"],\"type\":\"object\"},\"JsonRpcSuccess2\":{\"properties\":{\"id\":{\"$ref\":" +
  "\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"result\":{\"$ref\":\"#/$de" +
  "fs/PlanResult\"}},\"required\":[\"jsonrpc\",\"id\",\"result\"],\"type\":\"object\"},\"" +
  "JsonRpcSuccess3\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonr" +
  "pc\":{\"type\":\"string\"},\"result\":{\"$ref\":\"#/$defs/ApplyResult\"}},\"required" +
  "\":[\"jsonrpc\",\"id\",\"result\"],\"type\":\"object\"},\"JsonRpcSuccess4\":{\"propert" +
  "ies\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"res" +
  "ult\":{\"$ref\":\"#/$defs/GetResult\"}},\"required\":[\"jsonrpc\",\"id\",\"result\"]," +
  "\"type\":\"object\"},\"JsonRpcSuccess5\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/" +
  "RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"result\":{\"$ref\":\"#/$defs/Update" +
  "Result\"}},\"required\":[\"jsonrpc\",\"id\",\"result\"],\"type\":\"object\"},\"JsonRpc" +
  "Success6\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"t" +
  "ype\":\"string\"},\"result\":{\"$ref\":\"#/$defs/StopResult\"}},\"required\":[\"json" +
  "rpc\",\"id\",\"result\"],\"type\":\"object\"},\"JsonRpcSuccess7\":{\"properties\":{\"i" +
  "d\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\":\"string\"},\"result\":{\"$" +
  "ref\":\"#/$defs/RetryResult\"}},\"required\":[\"jsonrpc\",\"id\",\"result\"],\"type\"" +
  ":\"object\"},\"JsonRpcSuccess8\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/Reques" +
  "tId\"},\"jsonrpc\":{\"type\":\"string\"},\"result\":{\"$ref\":\"#/$defs/ResubmitResu" +
  "lt\"}},\"required\":[\"jsonrpc\",\"id\",\"result\"],\"type\":\"object\"},\"JsonRpcSucc" +
  "ess9\":{\"properties\":{\"id\":{\"$ref\":\"#/$defs/RequestId\"},\"jsonrpc\":{\"type\"" +
  ":\"string\"},\"result\":{\"$ref\":\"#/$defs/DeleteResult\"}},\"required\":[\"jsonrp" +
  "c\",\"id\",\"result\"],\"type\":\"object\"},\"Labels\":{\"additionalProperties\":{\"ma" +
  "xLength\":256,\"minLength\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]" +
  "+$\",\"type\":\"string\"},\"maxProperties\":64,\"propertyNames\":{\"maxLength\":256" +
  ",\"minLength\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"" +
  "string\"},\"type\":\"object\"},\"LogEventNotification\":{\"$ref\":\"#/$defs/LogEve" +
  "ntNotificationWire\"},\"LogEventNotificationWire\":{\"additionalProperties\":" +
  "false,\"properties\":{\"record\":{\"$ref\":\"#/$defs/LogRecord\"},\"subscriptionI" +
  "d\":{\"type\":\"string\"}},\"required\":[\"subscriptionId\",\"record\"],\"type\":\"obj" +
  "ect\"},\"LogLevel\":{\"enum\":[\"trace\",\"debug\",\"info\",\"warn\",\"error\"],\"type\":" +
  "\"string\"},\"LogRecord\":{\"additionalProperties\":false,\"description\":\"The c" +
  "losed public log record shape: a level, a bounded target, and a bounded " +
  "(possibly\\nredacted) message. No raw bytes, reasoning, tools, credential" +
  "s, env, or provider/session IDs\\nare representable.\",\"properties\":{\"leve" +
  "l\":{\"$ref\":\"#/$defs/LogLevel\"},\"message\":{\"maxLength\":16384,\"pattern\":\"^" +
  "[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]*$\",\"type\":\"string\"},\"target\":{\"maxLeng" +
  "th\":128,\"minLength\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"" +
  "type\":\"string\"}},\"required\":[\"level\",\"target\",\"message\"],\"type\":\"object\"" +
  "},\"LogsClosedNotification\":{\"additionalProperties\":false,\"description\":\"" +
  "Wire body of the terminal `subscription/closed` server notification for " +
  "a `logs` subscription.\\nDeliberately carries no cursor field -- `logs` g" +
  "ives a type-level \\\"cursorless\\\" guarantee, unlike\\n[`crate::Subscriptio" +
  "nClosedNotification`].\",\"properties\":{\"reason\":{\"$ref\":\"#/$defs/Subscrip" +
  "tionCloseReason\"},\"subscriptionId\":{\"type\":\"string\"}},\"required\":[\"subsc" +
  "riptionId\",\"reason\"],\"type\":\"object\"},\"LogsParams\":{\"additionalPropertie" +
  "s\":false,\"description\":\"`logs` establishment parameters. v1 has zero cal" +
  "ler filters: this is deliberately empty and\\nclosed, rejecting any unkno" +
  "wn field.\",\"type\":\"object\"},\"LogsResult\":{\"additionalProperties\":false,\"" +
  "description\":\"The `logs` establishment result: only a `subscriptionId`. " +
  "Deliberately carries no `runId` or\\n`atCursor` -- `logs` is not run-scop" +
  "ed and has no cursor.\",\"properties\":{\"subscriptionId\":{\"type\":\"string\"}}" +
  ",\"required\":[\"subscriptionId\"],\"type\":\"object\"},\"NodeAddress\":{\"addition" +
  "alProperties\":false,\"properties\":{\"attempt\":{\"maximum\":9007199254740991," +
  "\"minimum\":1,\"type\":\"integer\"},\"node\":{\"maxLength\":128,\"minLength\":1,\"pat" +
  "tern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"}},\"required\":[\"node\"," +
  "\"attempt\"],\"type\":\"object\"},\"NodeInstructions\":{\"maxLength\":16384,\"minLe" +
  "ngth\":1,\"pattern\":\"^[^\\\\u0000]*[^\\\\s\\\\u0000][^\\\\u0000]*$\",\"type\":\"string" +
  "\"},\"NodeOutputChannel\":{\"enum\":[\"out\",\"signal\",\"diagnostic\"],\"type\":\"str" +
  "ing\"},\"NodeOutputSelector\":{\"additionalProperties\":false,\"properties\":{\"" +
  "channel\":{\"$ref\":\"#/$defs/NodeOutputChannel\"},\"node\":{\"maxLength\":128,\"m" +
  "inLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"pat" +
  "h\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0" +
  "-9_.-]*$\",\"type\":\"string\"},\"maxItems\":64,\"minItems\":1,\"type\":\"array\"}},\"" +
  "required\":[\"node\",\"channel\",\"path\"],\"type\":\"object\"},\"NodeRuntimeBinding" +
  "\":{\"oneOf\":[{\"additionalProperties\":false,\"properties\":{\"connections\":{\"" +
  "$ref\":\"#/$defs/DeclaredConnections\"},\"effort\":{\"anyOf\":[{\"$ref\":\"#/$defs" +
  "/ReasoningEffort\"},{\"type\":\"null\"}]},\"kind\":{\"const\":\"agent\",\"type\":\"str" +
  "ing\"},\"model\":{\"maxLength\":128,\"minLength\":1,\"type\":\"string\"},\"sessionSc" +
  "ope\":{\"$ref\":\"#/$defs/SessionScope\"}},\"required\":[\"kind\",\"model\"],\"type\"" +
  ":\"object\"},{\"additionalProperties\":false,\"properties\":{\"connections\":{\"$" +
  "ref\":\"#/$defs/DeclaredConnections\"},\"kind\":{\"const\":\"git_delivery\",\"type" +
  "\":\"string\"}},\"required\":[\"kind\"],\"type\":\"object\"}]},\"NonEmptyVec_of_Choi" +
  "ceBranch\":{\"items\":{\"$ref\":\"#/$defs/ChoiceBranch\"},\"maxItems\":4096,\"minI" +
  "tems\":1,\"type\":\"array\"},\"NonEmptyVec_of_ControlSelector\":{\"items\":{\"$ref" +
  "\":\"#/$defs/ControlSelector\"},\"maxItems\":4096,\"minItems\":1,\"type\":\"array\"" +
  "},\"NonEmptyVec_of_FieldPath\":{\"items\":{\"items\":{\"maxLength\":128,\"minLeng" +
  "th\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"maxItems\"" +
  ":64,\"minItems\":1,\"type\":\"array\"},\"maxItems\":4096,\"minItems\":1,\"type\":\"ar" +
  "ray\"},\"NonEmptyVec_of_GraphNode\":{\"items\":{\"$ref\":\"#/$defs/GraphNode\"},\"" +
  "maxItems\":4096,\"minItems\":1,\"type\":\"array\"},\"NonEmptyVec_of_Guard\":{\"ite" +
  "ms\":{\"$ref\":\"#/$defs/Guard\"},\"maxItems\":4096,\"minItems\":1,\"type\":\"array\"" +
  "},\"NonEmptyVec_of_NodeName\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"pat" +
  "tern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"maxItems\":4096,\"min" +
  "Items\":1,\"type\":\"array\"},\"OperationalStatus\":{\"additionalProperties\":fal" +
  "se,\"properties\":{\"dispatchState\":{\"$ref\":\"#/$defs/DispatchState\"},\"inFli" +
  "ght\":{\"format\":\"uint32\",\"minimum\":0,\"type\":\"integer\"},\"labels\":{\"$ref\":\"" +
  "#/$defs/Labels\"},\"logLevel\":{\"$ref\":\"#/$defs/LogLevel\"},\"stopMode\":{\"any" +
  "Of\":[{\"$ref\":\"#/$defs/StopMode\"},{\"type\":\"null\"}]}},\"required\":[\"labels\"" +
  ",\"logLevel\",\"dispatchState\",\"inFlight\"],\"type\":\"object\"},\"PayloadType\":{" +
  "\"oneOf\":[{\"additionalProperties\":false,\"properties\":{\"kind\":{\"const\":\"nu" +
  "ll\",\"type\":\"string\"}},\"required\":[\"kind\"],\"type\":\"object\"},{\"additionalP" +
  "roperties\":false,\"properties\":{\"kind\":{\"const\":\"boolean\",\"type\":\"string\"" +
  "}},\"required\":[\"kind\"],\"type\":\"object\"},{\"additionalProperties\":false,\"p" +
  "roperties\":{\"kind\":{\"const\":\"integer\",\"type\":\"string\"}},\"required\":[\"kin" +
  "d\"],\"type\":\"object\"},{\"additionalProperties\":false,\"properties\":{\"kind\":" +
  "{\"const\":\"number\",\"type\":\"string\"}},\"required\":[\"kind\"],\"type\":\"object\"}" +
  ",{\"additionalProperties\":false,\"properties\":{\"kind\":{\"const\":\"string\",\"t" +
  "ype\":\"string\"}},\"required\":[\"kind\"],\"type\":\"object\"},{\"additionalPropert" +
  "ies\":false,\"properties\":{\"fields\":{\"additionalProperties\":{\"$ref\":\"#/$de" +
  "fs/RecordField\"},\"propertyNames\":{\"maxLength\":128,\"minLength\":1,\"pattern" +
  "\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"type\":\"object\"},\"kind\":" +
  "{\"const\":\"record\",\"type\":\"string\"}},\"required\":[\"kind\",\"fields\"],\"type\":" +
  "\"object\"},{\"additionalProperties\":false,\"properties\":{\"items\":{\"$ref\":\"#" +
  "/$defs/PayloadType\"},\"kind\":{\"const\":\"array\",\"type\":\"string\"}},\"required" +
  "\":[\"kind\",\"items\"],\"type\":\"object\"},{\"additionalProperties\":false,\"prope" +
  "rties\":{\"kind\":{\"const\":\"enum\",\"type\":\"string\"},\"values\":{\"items\":{\"maxL" +
  "ength\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"" +
  "string\"},\"maxItems\":4096,\"minItems\":1,\"type\":\"array\",\"uniqueItems\":true}" +
  "},\"required\":[\"kind\",\"values\"],\"type\":\"object\"}]},\"Phase\":{\"enum\":[\"empt" +
  "y\",\"admitting\",\"running\",\"finished\",\"deleting\"],\"type\":\"string\"},\"PlanPa" +
  "rams\":{\"additionalProperties\":false,\"properties\":{\"graph\":{\"$ref\":\"#/$de" +
  "fs/GraphSpec\"}},\"required\":[\"graph\"],\"type\":\"object\"},\"PlanResult\":{\"add" +
  "itionalProperties\":false,\"properties\":{\"bounds\":{\"anyOf\":[{\"$ref\":\"#/$de" +
  "fs/StructuralBounds\"},{\"type\":\"null\"}]},\"diagnostics\":{\"items\":{\"$ref\":\"" +
  "#/$defs/GraphDiagnostic\"},\"type\":\"array\"},\"ok\":{\"type\":\"boolean\"}},\"requ" +
  "ired\":[\"ok\",\"diagnostics\"],\"type\":\"object\"},\"PolicyBinding\":{\"additional" +
  "Properties\":false,\"properties\":{\"default\":{\"$ref\":\"#/$defs/PolicyDefault" +
  "\"},\"policy\":{\"maxLength\":256,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*@[1-9][" +
  "0-9]*$\",\"type\":\"string\"}},\"required\":[\"policy\",\"default\"],\"type\":\"object" +
  "\"},\"PolicyDefault\":{\"enum\":[\"deny\"],\"type\":\"string\"},\"ReasoningEffort\":{" +
  "\"enum\":[\"low\",\"medium\",\"high\",\"xhigh\",\"max\"],\"type\":\"string\"},\"RecordFie" +
  "ld\":{\"additionalProperties\":false,\"properties\":{\"required\":{\"type\":\"bool" +
  "ean\"},\"type\":{\"$ref\":\"#/$defs/PayloadType\"}},\"required\":[\"type\",\"require" +
  "d\"],\"type\":\"object\"},\"RedactionClass\":{\"enum\":[\"public\",\"internal\",\"conf" +
  "idential\",\"restricted\"],\"type\":\"string\"},\"RequestId\":{\"anyOf\":[{\"type\":\"" +
  "string\"},{\"format\":\"int64\",\"type\":\"integer\"}]},\"ResolvedSource\":{\"additi" +
  "onalProperties\":false,\"properties\":{\"branch\":{\"maxLength\":255,\"minLength" +
  "\":1,\"type\":\"string\"},\"repository\":{\"maxLength\":255,\"minLength\":3,\"patter" +
  "n\":\"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$\",\"type\":\"string\"},\"revision\":{\"pat" +
  "tern\":\"^[0-9a-f]{40}$\",\"type\":\"string\"}},\"required\":[\"repository\",\"branc" +
  "h\",\"revision\"],\"type\":\"object\"},\"ResubmitParams\":{\"additionalProperties\"" +
  ":false,\"properties\":{\"idempotencyKey\":{\"maxLength\":256,\"minLength\":1,\"pa" +
  "ttern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"},\"ifGenera" +
  "tion\":{\"maximum\":9007199254740991,\"minimum\":0,\"type\":\"integer\"},\"ifRunId" +
  "\":{\"type\":\"string\"},\"replacementInput\":true},\"required\":[\"ifGeneration\"," +
  "\"ifRunId\",\"idempotencyKey\"],\"type\":\"object\"},\"ResubmitResult\":{\"addition" +
  "alProperties\":false,\"properties\":{\"atCursor\":{\"type\":\"string\"},\"deduped\"" +
  ":{\"type\":\"boolean\"},\"generation\":{\"maximum\":9007199254740991,\"minimum\":0" +
  ",\"type\":\"integer\"},\"operational\":{\"$ref\":\"#/$defs/OperationalStatus\"},\"p" +
  "hase\":{\"$ref\":\"#/$defs/Phase\"},\"priorRunId\":{\"type\":\"string\"},\"runId\":{\"" +
  "type\":\"string\"}},\"required\":[\"generation\",\"priorRunId\",\"runId\",\"phase\",\"" +
  "operational\",\"atCursor\",\"deduped\"],\"type\":\"object\"},\"RetryParams\":{\"addi" +
  "tionalProperties\":false,\"properties\":{\"idempotencyKey\":{\"maxLength\":256," +
  "\"minLength\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"s" +
  "tring\"},\"ifGeneration\":{\"maximum\":9007199254740991,\"minimum\":0,\"type\":\"i" +
  "nteger\"}},\"required\":[\"ifGeneration\",\"idempotencyKey\"],\"type\":\"object\"}," +
  "\"RetryResult\":{\"additionalProperties\":false,\"properties\":{\"atCursor\":{\"t" +
  "ype\":\"string\"},\"deduped\":{\"type\":\"boolean\"},\"generation\":{\"maximum\":9007" +
  "199254740991,\"minimum\":0,\"type\":\"integer\"},\"operational\":{\"$ref\":\"#/$def" +
  "s/OperationalStatus\"},\"phase\":{\"$ref\":\"#/$defs/Phase\"},\"retriedTurnId\":{" +
  "\"type\":\"string\"},\"retryTurnId\":{\"type\":\"string\"},\"runId\":{\"type\":\"string" +
  "\"}},\"required\":[\"generation\",\"runId\",\"phase\",\"retriedTurnId\",\"retryTurnI" +
  "d\",\"operational\",\"atCursor\",\"deduped\"],\"type\":\"object\"},\"RunAttachEventN" +
  "otification\":{\"additionalProperties\":false,\"description\":\"One live read-" +
  "only attach event. Carrying both identities prevents events from simulta" +
  "neous\\nverifier attachments being confused on a multiplexed transport.\"," +
  "\"properties\":{\"event\":{\"$ref\":\"#/$defs/AgentAttachEvent\"},\"execution\":{\"" +
  "maxLength\":128,\"minLength\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009" +
  "f]+$\",\"type\":\"string\"},\"runId\":{\"type\":\"string\"},\"subscriptionId\":{\"type" +
  "\":\"string\"}},\"required\":[\"subscriptionId\",\"runId\",\"execution\",\"event\"],\"" +
  "type\":\"object\"},\"RunAttachParams\":{\"additionalProperties\":false,\"descrip" +
  "tion\":\"Establishes a live, read-only view of exactly one execution.\\n\\nA" +
  "ttach has no cursor and no replay. Historical output is available throug" +
  "h [`RunLogsParams`].\\nNo client-to-execution input message exists in thi" +
  "s contract.\",\"properties\":{\"execution\":{\"maxLength\":128,\"minLength\":1,\"p" +
  "attern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"},\"runId\":" +
  "{\"type\":\"string\"}},\"required\":[\"runId\",\"execution\"],\"type\":\"object\"},\"Ru" +
  "nAttachResult\":{\"additionalProperties\":false,\"properties\":{\"execution\":{" +
  "\"maxLength\":128,\"minLength\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u00" +
  "9f]+$\",\"type\":\"string\"},\"runId\":{\"type\":\"string\"},\"subscriptionId\":{\"typ" +
  "e\":\"string\"}},\"required\":[\"subscriptionId\",\"runId\",\"execution\"],\"type\":\"" +
  "object\"},\"RunForceParams\":{\"additionalProperties\":false,\"description\":\"R" +
  "equests the MVP's only stop mode: force. Repeated requests are idempoten" +
  "t at the run ledger.\",\"properties\":{\"runId\":{\"type\":\"string\"}},\"required" +
  "\":[\"runId\"],\"type\":\"object\"},\"RunForceResult\":{\"additionalProperties\":fa" +
  "lse,\"description\":\"The durable run status after recording the force requ" +
  "est.\",\"properties\":{\"atCursor\":{\"description\":\"Durable cursor after the " +
  "force request was recorded.\",\"type\":\"string\"},\"runId\":{\"description\":\"Pu" +
  "blic identity of the run whose force request was recorded.\",\"type\":\"stri" +
  "ng\"},\"size\":{\"$ref\":\"#/$defs/RunSize\",\"description\":\"Immutable execution" +
  " size selected for the run.\"},\"source\":{\"$ref\":\"#/$defs/ResolvedSource\"," +
  "\"description\":\"Immutable repository snapshot captured when the run was a" +
  "dmitted.\"},\"status\":{\"$ref\":\"#/$defs/RunStatus\",\"description\":\"Public ph" +
  "ase projected after the force request was recorded.\"},\"title\":{\"descript" +
  "ion\":\"Immutable title captured when the run was admitted.\",\"maxLength\":2" +
  "56,\"minLength\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\"" +
  ":\"string\"}},\"required\":[\"runId\",\"title\",\"source\",\"size\",\"atCursor\",\"stat" +
  "us\"],\"type\":\"object\"},\"RunListParams\":{\"additionalProperties\":false,\"des" +
  "cription\":\"The MVP inventory has no filters or pagination controls.\",\"ty" +
  "pe\":\"object\"},\"RunListResult\":{\"additionalProperties\":false,\"description" +
  "\":\"Current durable projections for every retained run.\",\"properties\":{\"r" +
  "uns\":{\"items\":{\"$ref\":\"#/$defs/RunStatusResult\"},\"type\":\"array\"}},\"requi" +
  "red\":[\"runs\"],\"type\":\"object\"},\"RunLogEventNotification\":{\"additionalPro" +
  "perties\":false,\"description\":\"One durable, reconnectable safe log record" +
  ". Run-wide system records have no execution;\\nexecution output carries t" +
  "he stable opaque selector used by status and attach.\",\"properties\":{\"cur" +
  "sor\":{\"type\":\"string\"},\"execution\":{\"maxLength\":128,\"minLength\":1,\"patte" +
  "rn\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":[\"string\",\"null\"]},\"re" +
  "cord\":{\"$ref\":\"#/$defs/LogRecord\"},\"runId\":{\"type\":\"string\"},\"subscripti" +
  "onId\":{\"type\":\"string\"}},\"required\":[\"subscriptionId\",\"runId\",\"cursor\",\"" +
  "record\"],\"type\":\"object\"},\"RunLogsParams\":{\"additionalProperties\":false," +
  "\"description\":\"Establishes durable run log replay followed by live deliv" +
  "ery.\\n\\nAn optional execution filter selects one active or settled execu" +
  "tion using the exact opaque\\nreference advertised by status. `fromCursor" +
  "` is exclusive, with the same reconnect semantics\\nas [`RunWatchParams`]" +
  ". Omitting both fields after `runId` replays the run's complete retained" +
  "\\nsafe log history.\",\"properties\":{\"execution\":{\"maxLength\":128,\"minLeng" +
  "th\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":[\"string\"," +
  "\"null\"]},\"fromCursor\":{\"type\":[\"string\",\"null\"]},\"runId\":{\"type\":\"string" +
  "\"}},\"required\":[\"runId\"],\"type\":\"object\"},\"RunLogsResult\":{\"additionalPr" +
  "operties\":false,\"properties\":{\"atCursor\":{\"type\":\"string\"},\"runId\":{\"typ" +
  "e\":\"string\"},\"subscriptionId\":{\"type\":\"string\"}},\"required\":[\"subscripti" +
  "onId\",\"runId\",\"atCursor\"],\"type\":\"object\"},\"RunMetadata\":{\"additionalPro" +
  "perties\":false,\"description\":\"Additive metadata emitted only with a term" +
  "inal run projection.\",\"properties\":{\"tokenUsage\":{\"anyOf\":[{\"$ref\":\"#/$d" +
  "efs/TokenUsage\"},{\"type\":\"null\"}]}},\"type\":\"object\"},\"RunSize\":{\"enum\":[" +
  "\"small\",\"medium\",\"large\"],\"type\":\"string\"},\"RunStatus\":{\"description\":\"P" +
  "ublic run state. The closed phase variants make impossible combinations " +
  "unrepresentable:\\nadmitted runs have no execution, stopping means force " +
  "was requested, and finished runs have\\nexactly one terminal result and n" +
  "o active execution. Running/stopping report every active\\nexecution rath" +
  "er than a single \\\"current worker\\\" slot.\",\"oneOf\":[{\"additionalProperti" +
  "es\":false,\"properties\":{\"phase\":{\"const\":\"admitted\",\"type\":\"string\"}},\"r" +
  "equired\":[\"phase\"],\"type\":\"object\"},{\"additionalProperties\":false,\"prope" +
  "rties\":{\"activeExecutions\":{\"items\":{\"$ref\":\"#/$defs/ActiveExecution\"},\"" +
  "type\":\"array\"},\"phase\":{\"const\":\"running\",\"type\":\"string\"}},\"required\":[" +
  "\"phase\",\"activeExecutions\"],\"type\":\"object\"},{\"additionalProperties\":fal" +
  "se,\"properties\":{\"activeExecutions\":{\"items\":{\"$ref\":\"#/$defs/ActiveExec" +
  "ution\"},\"type\":\"array\"},\"phase\":{\"const\":\"stopping\",\"type\":\"string\"}},\"r" +
  "equired\":[\"phase\",\"activeExecutions\"],\"type\":\"object\"},{\"additionalPrope" +
  "rties\":false,\"properties\":{\"metadata\":{\"$ref\":\"#/$defs/RunMetadata\",\"def" +
  "ault\":{}},\"phase\":{\"const\":\"finished\",\"type\":\"string\"},\"terminalResult\":" +
  "{\"$ref\":\"#/$defs/TerminalResult\"}},\"required\":[\"phase\",\"terminalResult\"]" +
  ",\"type\":\"object\"}]},\"RunStatusParams\":{\"additionalProperties\":false,\"pro" +
  "perties\":{\"runId\":{\"type\":\"string\"}},\"required\":[\"runId\"],\"type\":\"object" +
  "\"},\"RunStatusResult\":{\"additionalProperties\":false,\"properties\":{\"atCurs" +
  "or\":{\"type\":\"string\"},\"runId\":{\"type\":\"string\"},\"size\":{\"$ref\":\"#/$defs/" +
  "RunSize\"},\"source\":{\"$ref\":\"#/$defs/ResolvedSource\"},\"status\":{\"$ref\":\"#" +
  "/$defs/RunStatus\"},\"title\":{\"maxLength\":256,\"minLength\":1,\"pattern\":\"^[^" +
  "\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"}},\"required\":[\"runId\"" +
  ",\"title\",\"source\",\"size\",\"atCursor\",\"status\"],\"type\":\"object\"},\"RunSubmi" +
  "ssion\":{\"additionalProperties\":false,\"description\":\"Immutable, secret-fr" +
  "ee native-v2 submission admitted by the selected target.\",\"properties\":{" +
  "\"graph\":{\"$ref\":\"#/$defs/GraphSpec\"},\"initialInput\":true,\"runtime\":{\"$re" +
  "f\":\"#/$defs/RuntimePlan\"},\"source\":{\"$ref\":\"#/$defs/ResolvedSource\"},\"su" +
  "bmissionKey\":{\"maxLength\":256,\"minLength\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001" +
  "f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"},\"title\":{\"maxLength\":256,\"minLengt" +
  "h\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"}}," +
  "\"required\":[\"title\",\"graph\",\"initialInput\",\"runtime\",\"source\",\"submissio" +
  "nKey\"],\"type\":\"object\"},\"RunSubmitParams\":{\"additionalProperties\":false," +
  "\"description\":\"Trusted controller bootstrap admission. The host assigns " +
  "the only public run identity before\\ncontroller start; the immutable sub" +
  "mission remains identity-neutral.\",\"properties\":{\"runId\":{\"type\":\"string" +
  "\"},\"submission\":{\"$ref\":\"#/$defs/RunSubmission\"}},\"required\":[\"runId\",\"s" +
  "ubmission\"],\"type\":\"object\"},\"RunSubmitResult\":{\"additionalProperties\":f" +
  "alse,\"description\":\"A successful submission returns the one public ident" +
  "ity used by every later run method.\",\"properties\":{\"runId\":{\"type\":\"stri" +
  "ng\"}},\"required\":[\"runId\"],\"type\":\"object\"},\"RunWatchEventNotification\":" +
  "{\"additionalProperties\":false,\"description\":\"One durable public status p" +
  "rojection. `cursor` is stable run history, not a connection-local\\nseque" +
  "nce; clients resume strictly after it.\",\"properties\":{\"cursor\":{\"type\":\"" +
  "string\"},\"runId\":{\"type\":\"string\"},\"size\":{\"$ref\":\"#/$defs/RunSize\"},\"so" +
  "urce\":{\"$ref\":\"#/$defs/ResolvedSource\"},\"status\":{\"$ref\":\"#/$defs/RunSta" +
  "tus\"},\"subscriptionId\":{\"type\":\"string\"},\"title\":{\"maxLength\":256,\"minLe" +
  "ngth\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"" +
  "}},\"required\":[\"subscriptionId\",\"runId\",\"title\",\"source\",\"size\",\"cursor\"" +
  ",\"status\"],\"type\":\"object\"},\"RunWatchParams\":{\"additionalProperties\":fal" +
  "se,\"description\":\"Establishes a durable run watch.\\n\\n`fromCursor` is ex" +
  "clusive. Reconnecting with the last delivered cursor therefore returns e" +
  "ach\\nlater watch record once, with no replayed boundary record and no sk" +
  "ipped later record.\",\"properties\":{\"fromCursor\":{\"type\":[\"string\",\"null\"" +
  "]},\"runId\":{\"type\":\"string\"}},\"required\":[\"runId\"],\"type\":\"object\"},\"Run" +
  "WatchResult\":{\"additionalProperties\":false,\"properties\":{\"atCursor\":{\"ty" +
  "pe\":\"string\"},\"runId\":{\"type\":\"string\"},\"subscriptionId\":{\"type\":\"string" +
  "\"}},\"required\":[\"subscriptionId\",\"runId\",\"atCursor\"],\"type\":\"object\"},\"R" +
  "untimePlan\":{\"oneOf\":[{\"additionalProperties\":false,\"properties\":{\"harne" +
  "ss\":{\"const\":\"codex\",\"type\":\"string\"},\"nodes\":{\"additionalProperties\":fa" +
  "lse,\"patternProperties\":{\"^[A-Za-z_][A-Za-z0-9_.-]*$\":{\"$ref\":\"#/$defs/N" +
  "odeRuntimeBinding\"}},\"type\":\"object\"},\"provider\":{\"$ref\":\"#/$defs/CodexP" +
  "rovider\"},\"size\":{\"$ref\":\"#/$defs/RunSize\"}},\"required\":[\"harness\",\"prov" +
  "ider\",\"size\",\"nodes\"],\"type\":\"object\"},{\"additionalProperties\":false,\"pr" +
  "operties\":{\"harness\":{\"const\":\"claude\",\"type\":\"string\"},\"nodes\":{\"additi" +
  "onalProperties\":false,\"patternProperties\":{\"^[A-Za-z_][A-Za-z0-9_.-]*$\":" +
  "{\"$ref\":\"#/$defs/NodeRuntimeBinding\"}},\"type\":\"object\"},\"provider\":{\"$re" +
  "f\":\"#/$defs/ClaudeProvider\"},\"size\":{\"$ref\":\"#/$defs/RunSize\"}},\"require" +
  "d\":[\"harness\",\"provider\",\"size\",\"nodes\"],\"type\":\"object\"}]},\"ServerCapab" +
  "ilities\":{\"additionalProperties\":false,\"properties\":{\"agentAttach\":{\"def" +
  "ault\":false,\"type\":\"boolean\"},\"graphProfiles\":{\"default\":[],\"items\":{\"$r" +
  "ef\":\"#/$defs/GraphProfile\"},\"maxItems\":2,\"not\":{\"minItems\":2,\"prefixItem" +
  "s\":[{\"const\":\"openengine.graph.single-worker/v1\"},{\"const\":\"openengine.g" +
  "raph.full/v1\"}]},\"type\":\"array\",\"uniqueItems\":true},\"logs\":{\"default\":fa" +
  "lse,\"type\":\"boolean\"}},\"type\":\"object\"},\"SessionScope\":{\"enum\":[\"executi" +
  "on\",\"node_instance\"],\"type\":\"string\"},\"StopMode\":{\"enum\":[\"drain\",\"force" +
  "\"],\"type\":\"string\"},\"StopParams\":{\"additionalProperties\":false,\"properti" +
  "es\":{\"idempotencyKey\":{\"maxLength\":256,\"minLength\":1,\"pattern\":\"^[^\\\\u00" +
  "00-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\":\"string\"},\"ifGeneration\":{\"maximum\"" +
  ":9007199254740991,\"minimum\":0,\"type\":\"integer\"},\"mode\":{\"$ref\":\"#/$defs/" +
  "StopMode\"}},\"required\":[\"mode\",\"ifGeneration\",\"idempotencyKey\"],\"type\":\"" +
  "object\"},\"StopResult\":{\"additionalProperties\":false,\"properties\":{\"accep" +
  "tedMode\":{\"$ref\":\"#/$defs/StopMode\"},\"atCursor\":{\"type\":\"string\"},\"dedup" +
  "ed\":{\"type\":\"boolean\"},\"effectiveMode\":{\"$ref\":\"#/$defs/StopMode\"},\"gene" +
  "ration\":{\"maximum\":9007199254740991,\"minimum\":0,\"type\":\"integer\"},\"opera" +
  "tional\":{\"$ref\":\"#/$defs/OperationalStatus\"},\"phase\":{\"$ref\":\"#/$defs/Ph" +
  "ase\"},\"runId\":{\"type\":\"string\"}},\"required\":[\"generation\",\"runId\",\"phase" +
  "\",\"acceptedMode\",\"effectiveMode\",\"operational\",\"atCursor\",\"deduped\"],\"ty" +
  "pe\":\"object\"},\"StructuralBounds\":{\"additionalProperties\":false,\"properti" +
  "es\":{\"attemptsPerNode\":{\"additionalProperties\":{\"maximum\":90071992547409" +
  "91,\"minimum\":1,\"type\":\"integer\"},\"propertyNames\":{\"maxLength\":128,\"minLe" +
  "ngth\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"type\":\"" +
  "object\"},\"maxNodeExecutions\":{\"maximum\":9007199254740991,\"minimum\":1,\"ty" +
  "pe\":\"integer\"},\"peakConcurrency\":{\"maximum\":9007199254740991,\"minimum\":1" +
  ",\"type\":\"integer\"},\"termination\":{\"$ref\":\"#/$defs/TerminationWitness\"}}," +
  "\"required\":[\"termination\",\"maxNodeExecutions\",\"peakConcurrency\",\"attempt" +
  "sPerNode\"],\"type\":\"object\"},\"SubscriptionCancelParams\":{\"additionalPrope" +
  "rties\":false,\"description\":\"Wire body of the generic `subscription/cance" +
  "l` client notification.\",\"properties\":{\"subscriptionId\":{\"type\":\"string\"" +
  "}},\"required\":[\"subscriptionId\"],\"type\":\"object\"},\"SubscriptionCloseReas" +
  "on\":{\"enum\":[\"done\",\"SLOW_CONSUMER\"],\"type\":\"string\"},\"SubscriptionClose" +
  "dNotification\":{\"additionalProperties\":false,\"description\":\"Wire body of" +
  " the terminal `subscription/closed` server notification.\",\"properties\":{" +
  "\"lastDeliveredCursor\":{\"type\":[\"string\",\"null\"]},\"reason\":{\"$ref\":\"#/$de" +
  "fs/SubscriptionCloseReason\"},\"subscriptionId\":{\"type\":\"string\"}},\"requir" +
  "ed\":[\"subscriptionId\",\"reason\"],\"type\":\"object\"},\"TerminalResult\":{\"desc" +
  "ription\":\"Authoritative terminal value for backends that can durably rec" +
  "onstruct a completed graph.\\n\\nThis is additive to [`GetResult`]: backen" +
  "ds that do not yet expose terminal values leave the\\noptional field abse" +
  "nt, including when their status is already `finished`.\",\"oneOf\":[{\"addit" +
  "ionalProperties\":false,\"properties\":{\"output\":true,\"status\":{\"const\":\"su" +
  "cceeded\",\"type\":\"string\"}},\"required\":[\"status\",\"output\"],\"type\":\"object" +
  "\"},{\"additionalProperties\":false,\"properties\":{\"reason\":{\"maxLength\":128" +
  ",\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"" +
  "status\":{\"const\":\"failed\",\"type\":\"string\"}},\"required\":[\"status\",\"reason" +
  "\"],\"type\":\"object\"}]},\"TerminationWitness\":{\"oneOf\":[{\"additionalPropert" +
  "ies\":false,\"properties\":{\"kind\":{\"const\":\"acyclic\",\"type\":\"string\"},\"ord" +
  "er\":{\"$ref\":\"#/$defs/NonEmptyVec_of_NodeName\"}},\"required\":[\"kind\",\"orde" +
  "r\"],\"type\":\"object\"},{\"additionalProperties\":false,\"properties\":{\"kind\":" +
  "{\"const\":\"bounded\",\"type\":\"string\"},\"maxIterations\":{\"maximum\":900719925" +
  "4740991,\"minimum\":1,\"type\":\"integer\"},\"ranking\":{\"$ref\":\"#/$defs/NonEmpt" +
  "yVec_of_FieldPath\"}},\"required\":[\"kind\",\"ranking\",\"maxIterations\"],\"type" +
  "\":\"object\"}]},\"TokenUsage\":{\"additionalProperties\":false,\"description\":\"" +
  "Run-wide sum of provider-reported usage for every launched agent invocat" +
  "ion.\\n\\n`complete` is false when at least one invocation did not report " +
  "usable counters. Cache\\ncounters are omitted when the provider does not " +
  "expose them consistently.\",\"properties\":{\"cacheCreationInputTokens\":{\"ma" +
  "ximum\":9007199254740991,\"minimum\":0,\"type\":[\"integer\",\"null\"]},\"cacheRea" +
  "dInputTokens\":{\"maximum\":9007199254740991,\"minimum\":0,\"type\":[\"integer\"," +
  "\"null\"]},\"complete\":{\"type\":\"boolean\"},\"inputTokens\":{\"maximum\":90071992" +
  "54740991,\"minimum\":0,\"type\":\"integer\"},\"outputTokens\":{\"maximum\":9007199" +
  "254740991,\"minimum\":0,\"type\":\"integer\"}},\"required\":[\"inputTokens\",\"outp" +
  "utTokens\",\"complete\"],\"type\":\"object\"},\"UpdateParams\":{\"additionalProper" +
  "ties\":false,\"anyOf\":[{\"required\":[\"labels\"]},{\"required\":[\"logLevel\"]},{" +
  "\"required\":[\"suspended\"]}],\"properties\":{\"idempotencyKey\":{\"maxLength\":2" +
  "56,\"minLength\":1,\"pattern\":\"^[^\\\\u0000-\\\\u001f\\\\u007f-\\\\u009f]+$\",\"type\"" +
  ":\"string\"},\"ifGeneration\":{\"maximum\":9007199254740991,\"minimum\":0,\"type\"" +
  ":\"integer\"},\"labels\":{\"$ref\":\"#/$defs/Labels\"},\"logLevel\":{\"$ref\":\"#/$de" +
  "fs/LogLevel\"},\"suspended\":{\"type\":\"boolean\"}},\"required\":[\"ifGeneration\"" +
  ",\"idempotencyKey\"],\"type\":\"object\"},\"UpdateResult\":{\"additionalPropertie" +
  "s\":false,\"properties\":{\"atCursor\":{\"type\":\"string\"},\"deduped\":{\"type\":\"b" +
  "oolean\"},\"generation\":{\"maximum\":9007199254740991,\"minimum\":0,\"type\":\"in" +
  "teger\"},\"operational\":{\"$ref\":\"#/$defs/OperationalStatus\"},\"phase\":{\"$re" +
  "f\":\"#/$defs/Phase\"},\"runId\":{\"type\":\"string\"}},\"required\":[\"generation\"," +
  "\"runId\",\"phase\",\"operational\",\"atCursor\",\"deduped\"],\"type\":\"object\"},\"Wa" +
  "tchEvent\":{\"description\":\"The closed public event algebra. `Phase` folds" +
  " the observable cluster status (admission\\ncommit, update, suspend/resum" +
  "e, stop-request); `NodeBegin`/`NodeEnd` are a testkit-only\\nsynthetic ho" +
  "ok decoupled from the real dispatch/lease turn mechanism, since no nativ" +
  "e graph\\nexecutor exists yet; `Bookmark` advances the cursor without cha" +
  "nging folded public state;\\n`Fault` carries a durable, backend-neutral p" +
  "rojected `BackendFault`: it correlates to the\\nenclosing `EventNotificat" +
  "ion.run_id` plus its own optional opaque `executionRef`, and its\\norderi" +
  "ng/emission never itself authorizes a retry or changes terminal semantic" +
  "s -- it folds to\\nno public status change, exactly like `Bookmark`; `Fin" +
  "ished` is always the last event for a\\nrun.\",\"oneOf\":[{\"additionalProper" +
  "ties\":false,\"properties\":{\"admission\":{\"anyOf\":[{\"$ref\":\"#/$defs/Admissi" +
  "onTransition\"},{\"type\":\"null\"}]},\"status\":{\"$ref\":\"#/$defs/ClusterStatus" +
  "\"},\"type\":{\"const\":\"phase\",\"type\":\"string\"}},\"required\":[\"type\",\"status\"" +
  "],\"type\":\"object\"},{\"additionalProperties\":false,\"properties\":{\"input\":t" +
  "rue,\"node\":{\"$ref\":\"#/$defs/NodeAddress\"},\"type\":{\"const\":\"node_begin\",\"" +
  "type\":\"string\"}},\"required\":[\"type\",\"node\",\"input\"],\"type\":\"object\"},{\"a" +
  "dditionalProperties\":false,\"properties\":{\"node\":{\"$ref\":\"#/$defs/NodeAdd" +
  "ress\"},\"outcome\":{\"$ref\":\"#/$defs/WorkerOutcome\"},\"type\":{\"const\":\"node_" +
  "end\",\"type\":\"string\"}},\"required\":[\"type\",\"node\",\"outcome\"],\"type\":\"obje" +
  "ct\"},{\"additionalProperties\":false,\"properties\":{\"type\":{\"const\":\"bookma" +
  "rk\",\"type\":\"string\"}},\"required\":[\"type\"],\"type\":\"object\"},{\"additionalP" +
  "roperties\":false,\"properties\":{\"fault\":{\"$ref\":\"#/$defs/BackendFault\"},\"" +
  "type\":{\"const\":\"fault\",\"type\":\"string\"}},\"required\":[\"type\",\"fault\"],\"ty" +
  "pe\":\"object\"},{\"additionalProperties\":false,\"properties\":{\"final_status\"" +
  ":{\"$ref\":\"#/$defs/ClusterStatus\"},\"stop_mode\":{\"anyOf\":[{\"$ref\":\"#/$defs" +
  "/StopMode\"},{\"type\":\"null\"}]},\"type\":{\"const\":\"finished\",\"type\":\"string\"" +
  "}},\"required\":[\"type\",\"final_status\"],\"type\":\"object\"}]},\"WatchParams\":{" +
  "\"additionalProperties\":false,\"properties\":{\"fromCursor\":{\"default\":null," +
  "\"type\":[\"string\",\"null\"]},\"runId\":{\"default\":null,\"type\":[\"string\",\"null" +
  "\"]}},\"type\":\"object\"},\"WatchResult\":{\"properties\":{\"atCursor\":{\"type\":[\"" +
  "string\",\"null\"]},\"runId\":{\"type\":[\"string\",\"null\"]},\"subscriptionId\":{\"t" +
  "ype\":\"string\"}},\"required\":[\"subscriptionId\"],\"type\":\"object\"},\"WorkerEr" +
  "rorCode\":{\"enum\":[\"timeout\",\"crash\",\"malformed\",\"refusal\"],\"type\":\"strin" +
  "g\"},\"WorkerFailureReason\":{\"enum\":[\"declared_failure\",\"policy_denied\",\"i" +
  "nteractive_input_required\",\"authentication_required\",\"malformed_result\"]" +
  ",\"type\":\"string\"},\"WorkerOutcome\":{\"allOf\":[{\"$ref\":\"#/$defs/WorkerOutco" +
  "meWire\"},{\"if\":{\"properties\":{\"status\":{\"const\":\"error\"}},\"required\":[\"s" +
  "tatus\"]},\"then\":{\"oneOf\":[{\"properties\":{\"reason\":{\"const\":\"declared_fai" +
  "lure\"}},\"required\":[\"reason\"]},{\"properties\":{\"code\":{\"const\":\"refusal\"}" +
  ",\"reason\":{\"enum\":[\"policy_denied\",\"interactive_input_required\",\"authent" +
  "ication_required\"]}},\"required\":[\"code\",\"reason\"]},{\"properties\":{\"code\"" +
  ":{\"const\":\"malformed\"},\"reason\":{\"const\":\"malformed_result\"}},\"required\"" +
  ":[\"code\",\"reason\"]}]}}]},\"WorkerOutcomeWire\":{\"oneOf\":[{\"additionalPrope" +
  "rties\":false,\"properties\":{\"artifacts\":{\"items\":{\"$ref\":\"#/$defs/Artifac" +
  "tRef\"},\"type\":\"array\"},\"output\":true,\"status\":{\"const\":\"verified\",\"type\"" +
  ":\"string\"}},\"required\":[\"status\",\"output\",\"artifacts\"],\"type\":\"object\"}," +
  "{\"additionalProperties\":false,\"properties\":{\"artifacts\":{\"items\":{\"$ref\"" +
  ":\"#/$defs/ArtifactRef\"},\"type\":\"array\"},\"diagnostic\":true,\"output\":true," +
  "\"signals\":{\"additionalProperties\":{\"maxLength\":128,\"minLength\":1,\"patter" +
  "n\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"propertyNames\":{\"maxLe" +
  "ngth\":128,\"minLength\":1,\"pattern\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"s" +
  "tring\"},\"type\":\"object\"},\"status\":{\"const\":\"verifier\",\"type\":\"string\"}}," +
  "\"required\":[\"status\",\"output\",\"signals\",\"diagnostic\",\"artifacts\"],\"type\"" +
  ":\"object\"},{\"additionalProperties\":false,\"properties\":{\"code\":{\"$ref\":\"#" +
  "/$defs/WorkerErrorCode\"},\"reason\":{\"$ref\":\"#/$defs/WorkerFailureReason\"}" +
  ",\"status\":{\"const\":\"error\",\"type\":\"string\"}},\"required\":[\"status\",\"code\"" +
  ",\"reason\"],\"type\":\"object\"}]},\"WriteBinding\":{\"additionalProperties\":fal" +
  "se,\"properties\":{\"target\":{\"items\":{\"maxLength\":128,\"minLength\":1,\"patte" +
  "rn\":\"^[A-Za-z_][A-Za-z0-9_.-]*$\",\"type\":\"string\"},\"maxItems\":64,\"minItem" +
  "s\":1,\"type\":\"array\"},\"value\":{\"$ref\":\"#/$defs/NodeOutputSelector\"}},\"req" +
  "uired\":[\"value\",\"target\"],\"type\":\"object\"}},\"$schema\":\"https://json-sche" +
  "ma.org/draft/2020-12/schema\",\"properties\":{\"agent_attach_closed_notifica" +
  "tion\":{\"$ref\":\"#/$defs/JsonRpcNotification8\"},\"agent_attach_event_notifi" +
  "cation\":{\"$ref\":\"#/$defs/JsonRpcNotification7\"},\"agent_attach_request\":{" +
  "\"$ref\":\"#/$defs/JsonRpcRequest12\"},\"agent_attach_response\":{\"$ref\":\"#/$d" +
  "efs/JsonRpcResponse12\"},\"apply_request\":{\"$ref\":\"#/$defs/JsonRpcRequest3" +
  "\"},\"apply_response\":{\"$ref\":\"#/$defs/JsonRpcResponse3\"},\"cancel_request_" +
  "notification\":{\"$ref\":\"#/$defs/JsonRpcNotification4\"},\"delete_request\":{" +
  "\"$ref\":\"#/$defs/JsonRpcRequest9\"},\"delete_response\":{\"$ref\":\"#/$defs/Jso" +
  "nRpcResponse9\"},\"event_notification\":{\"$ref\":\"#/$defs/JsonRpcNotificatio" +
  "n\"},\"get_request\":{\"$ref\":\"#/$defs/JsonRpcRequest4\"},\"get_response\":{\"$r" +
  "ef\":\"#/$defs/JsonRpcResponse4\"},\"initialize_request\":{\"$ref\":\"#/$defs/Js" +
  "onRpcRequest\"},\"initialize_response\":{\"$ref\":\"#/$defs/JsonRpcResponse\"}," +
  "\"log_event_notification\":{\"$ref\":\"#/$defs/JsonRpcNotification5\"},\"logs_c" +
  "losed_notification\":{\"$ref\":\"#/$defs/JsonRpcNotification6\"},\"logs_reques" +
  "t\":{\"$ref\":\"#/$defs/JsonRpcRequest11\"},\"logs_response\":{\"$ref\":\"#/$defs/" +
  "JsonRpcResponse11\"},\"plan_request\":{\"$ref\":\"#/$defs/JsonRpcRequest2\"},\"p" +
  "lan_response\":{\"$ref\":\"#/$defs/JsonRpcResponse2\"},\"resubmit_request\":{\"$" +
  "ref\":\"#/$defs/JsonRpcRequest8\"},\"resubmit_response\":{\"$ref\":\"#/$defs/Jso" +
  "nRpcResponse8\"},\"retry_request\":{\"$ref\":\"#/$defs/JsonRpcRequest7\"},\"retr" +
  "y_response\":{\"$ref\":\"#/$defs/JsonRpcResponse7\"},\"run_attach_event_notifi" +
  "cation\":{\"$ref\":\"#/$defs/JsonRpcNotification11\"},\"run_attach_request\":{\"" +
  "$ref\":\"#/$defs/JsonRpcRequest18\"},\"run_attach_response\":{\"$ref\":\"#/$defs" +
  "/JsonRpcResponse18\"},\"run_force_request\":{\"$ref\":\"#/$defs/JsonRpcRequest" +
  "19\"},\"run_force_response\":{\"$ref\":\"#/$defs/JsonRpcResponse19\"},\"run_list" +
  "_request\":{\"$ref\":\"#/$defs/JsonRpcRequest14\"},\"run_list_response\":{\"$ref" +
  "\":\"#/$defs/JsonRpcResponse14\"},\"run_log_event_notification\":{\"$ref\":\"#/$" +
  "defs/JsonRpcNotification10\"},\"run_logs_request\":{\"$ref\":\"#/$defs/JsonRpc" +
  "Request17\"},\"run_logs_response\":{\"$ref\":\"#/$defs/JsonRpcResponse17\"},\"ru" +
  "n_status_request\":{\"$ref\":\"#/$defs/JsonRpcRequest15\"},\"run_status_respon" +
  "se\":{\"$ref\":\"#/$defs/JsonRpcResponse15\"},\"run_submit_request\":{\"$ref\":\"#" +
  "/$defs/JsonRpcRequest13\"},\"run_submit_response\":{\"$ref\":\"#/$defs/JsonRpc" +
  "Response13\"},\"run_watch_event_notification\":{\"$ref\":\"#/$defs/JsonRpcNoti" +
  "fication9\"},\"run_watch_request\":{\"$ref\":\"#/$defs/JsonRpcRequest16\"},\"run" +
  "_watch_response\":{\"$ref\":\"#/$defs/JsonRpcResponse16\"},\"stop_request\":{\"$" +
  "ref\":\"#/$defs/JsonRpcRequest6\"},\"stop_response\":{\"$ref\":\"#/$defs/JsonRpc" +
  "Response6\"},\"subscription_cancel_notification\":{\"$ref\":\"#/$defs/JsonRpcN" +
  "otification2\"},\"subscription_closed_notification\":{\"$ref\":\"#/$defs/JsonR" +
  "pcNotification3\"},\"update_request\":{\"$ref\":\"#/$defs/JsonRpcRequest5\"},\"u" +
  "pdate_response\":{\"$ref\":\"#/$defs/JsonRpcResponse5\"},\"watch_request\":{\"$r" +
  "ef\":\"#/$defs/JsonRpcRequest10\"},\"watch_response\":{\"$ref\":\"#/$defs/JsonRp" +
  "cResponse10\"}},\"required\":[\"initialize_request\",\"initialize_response\",\"p" +
  "lan_request\",\"plan_response\",\"apply_request\",\"apply_response\",\"get_reque" +
  "st\",\"get_response\",\"update_request\",\"update_response\",\"stop_request\",\"st" +
  "op_response\",\"retry_request\",\"retry_response\",\"resubmit_request\",\"resubm" +
  "it_response\",\"delete_request\",\"delete_response\",\"watch_request\",\"watch_r" +
  "esponse\",\"event_notification\",\"subscription_cancel_notification\",\"subscr" +
  "iption_closed_notification\",\"cancel_request_notification\",\"logs_request\"" +
  ",\"logs_response\",\"log_event_notification\",\"logs_closed_notification\",\"ag" +
  "ent_attach_request\",\"agent_attach_response\",\"agent_attach_event_notifica" +
  "tion\",\"agent_attach_closed_notification\",\"run_submit_request\",\"run_submi" +
  "t_response\",\"run_list_request\",\"run_list_response\",\"run_status_request\"," +
  "\"run_status_response\",\"run_watch_request\",\"run_watch_response\",\"run_watc" +
  "h_event_notification\",\"run_logs_request\",\"run_logs_response\",\"run_log_ev" +
  "ent_notification\",\"run_attach_request\",\"run_attach_response\",\"run_attach" +
  "_event_notification\",\"run_force_request\",\"run_force_response\"],\"title\":\"" +
  "ImplementedProtocolSchema\",\"type\":\"object\"}"
);
