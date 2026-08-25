name: Feature request
about: Propose a new module, capability, or change
labels: enhancement
body:
  - type: textarea
    id: problem
    attributes:
      label: What problem does this solve?
      description: What can't you do today, or what hurts?
    validations:
      required: true
  - type: textarea
    id: proposal
    attributes:
      label: Proposed solution
    validations:
      required: true
  - type: dropdown
    id: scope
    attributes:
      label: Scope
      options:
        - existing module
        - new module
        - service API
        - CLI / UX
        - docs
        - unsure
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives considered
