from pydantic import BaseModel, Field


class ChannelConfig(BaseModel):
    subscriptions: list[str] = Field(default_factory=list)


class AgentManifest(BaseModel):
    name: str
    description: str = "An openark agent"
    modules: dict[str, bool] = Field(default_factory=dict)
    channels: ChannelConfig = Field(default_factory=ChannelConfig)


class AgentCreateRequest(BaseModel):
    name: str
    description: str = "An openark agent"
    persona: str | None = None


class PersonaEvolveRequest(BaseModel):
    signals: list[str] = Field(default_factory=list)
    threshold: int = Field(default=3, ge=1, le=20)


class PersonaReplace(BaseModel):
    old: str
    new: str


class PersonaEvolveResponse(BaseModel):
    updated: bool = False
    added: list[str] = Field(default_factory=list)
    replaced: list[PersonaReplace] = Field(default_factory=list)
    reason: str | None = None


class MemoryItem(BaseModel):
    id: str
    text: str
    score: float = 0.0
    source_agent: str | None = None


class MemoryRecallResponse(BaseModel):
    memories: list[MemoryItem] = Field(default_factory=list)


class MemoryCreateRequest(BaseModel):
    text: str = Field(min_length=1)
    project: str | None = None


class MemoryIngestRequest(BaseModel):
    text: str = Field(min_length=1)
    project: str | None = None


class MemoryMutation(BaseModel):
    id: str
    event: str = "ADD"


class MemoryIngestResponse(BaseModel):
    added: int = 0
    facts: list[str] = Field(default_factory=list)
    reason: str | None = None


class PersonaResponse(BaseModel):
    core: str
    evolving: str


class Lesson(BaseModel):
    id: str
    rule: str
    hits: int = 0
    status: str = "active"
    source: str = "reflection"


class LessonsResponse(BaseModel):
    lessons: list[Lesson] = Field(default_factory=list)


class FailureReport(BaseModel):
    tool: str = "unknown"
    ok: bool = False
    duration_ms: int = 0
    summary: str = ""


class ReflectRequest(BaseModel):
    failures: list[FailureReport] = Field(default_factory=list)
    messages: list[str] = Field(default_factory=list)


class LessonPayload(BaseModel):
    id: str
    rule: str
    status: str
    source: str
    hits: int


class ReflectResponse(BaseModel):
    added: list[LessonPayload] = Field(default_factory=list)
    skipped: int = 0
    reason: str | None = None


class LessonAddRequest(BaseModel):
    rule: str
    source: str = "manual"


class LessonAddResponse(BaseModel):
    added: LessonPayload | None = None
    reason: str | None = None


class LessonRetireResponse(BaseModel):
    retired: bool = False
    reason: str | None = None


class LessonHitsRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)
    session_id: str


class LessonHitsResponse(BaseModel):
    counted: bool = False
    retired: list[str] = Field(default_factory=list)


class SkillSummary(BaseModel):
    name: str
    description: str
    status: str = "verified"


class SkillsResponse(BaseModel):
    skills: list[SkillSummary] = Field(default_factory=list)


class DistillRequest(BaseModel):
    trace: str


class SkillPayload(BaseModel):
    name: str
    description: str
    status: str


class DistillResponse(BaseModel):
    created: SkillPayload | None = None
    reason: str | None = None


class SkillVerifyResponse(BaseModel):
    verified: bool = False
    reason: str | None = None


class ChannelItem(BaseModel):
    id: str
    text: str
    source_agent: str
    kind: str = "memory"


class ChannelPushRequest(BaseModel):
    text: str
    kind: str = "memory"
