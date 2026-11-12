"""Prompts start as .md files in this folder. Versions edited in the UI are kept in MongoDB
(harness/prompt_registry.py); load_prompt("coding") returns the active version, or prompts/coding.md."""


def load_prompt(name: str) -> str:
    from harness import prompt_registry
    return prompt_registry.get(name)
