name: Bug report
about: Something is broken
labels: bug
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: Also tell us what you expected to happen.
    validations:
      required: true
  - type: dropdown
    id: area
    attributes:
      label: Area
      options:
        - plugin
        - service
        - CLI / installer
        - docs
        - other
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: Relevant output
      description: >
        For agent behavior bugs include the relevant
        ~/.openark/agents/<name>/logs/audit.log excerpt. Redact anything
        private.
      render: shell
  - type: textarea
    id: env
    attributes:
      label: Environment
      placeholder: OS, opencode version, node/python versions, agent name
    validations:
      required: true
