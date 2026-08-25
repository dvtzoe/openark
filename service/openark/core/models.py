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


class MemoryItem(BaseModel):
    id: str
    text: str
    score: float = 0.0


class MemoryRecallResponse(BaseModel):
    memories: list[MemoryItem] = []


class MemoryCreateRequest(BaseModel):
    text: str


class PersonaResponse(BaseModel):
    core: str
    evolving: str


class Lesson(BaseModel):
    id: str
    rule: str
    hits: int = 0


class LessonsResponse(BaseModel):
    lessons: list[Lesson] = []


class FailureReport(BaseModel):
    tool: str
    ok: bool
    duration_ms: int = 0
    summary: str = ""


class ReflectRequest(BaseModel):
    failures: list[FailureReport]


class SkillSummary(BaseModel):
    name: str
    description: str


class SkillsResponse(BaseModel):
    skills: list[SkillSummary] = []


class ChannelItem(BaseModel):
    id: str
    text: str
    source_agent: str
    kind: str = "memory"


class ChannelPushRequest(BaseModel):
    text: str
    kind: str = "memory"
