"""The agent's environment variables, checked once at start-up (as loadEnv in TypeScript)."""

import os
import re
from dataclasses import dataclass

from appcommon.errors import ConfigError


@dataclass(frozen=True)
class Settings:
    port: int
    database_url: str
    query_api_url: str
    platform_url: str
    internal_token: str
    models_file: str
    #: None: no key, so the built-in stand-in answers instead of a model.
    openrouter_api_key: str | None
    default_dashboard_range: str

    @classmethod
    def from_env(cls) -> 'Settings':
        """Read and check every variable; report every problem at once."""
        env = os.environ
        problems: list[str] = []

        def required(name: str) -> str:
            value = env.get(name, '')
            if value == '':
                problems.append(f'{name} is required.')
            return value

        def url(name: str) -> str:
            value = required(name)
            if value and not re.match(r'^https?://', value):
                problems.append(f'{name} must be an http(s) URL.')
            return value.rstrip('/')

        port_text = env.get('PORT') or '8080'
        if not port_text.isdigit() or int(port_text) == 0:
            problems.append('PORT must be a positive whole number.')
        database_url = required('DATABASE_URL')
        if database_url and not re.match(r'^postgres(ql)?://', database_url):
            problems.append('DATABASE_URL must be a postgres:// URL.')
        query_api_url = url('QUERY_API_URL')
        platform_url = url('PLATFORM_URL')
        token = required('INTERNAL_API_TOKEN')
        dashboard_range = env.get('DEFAULT_DASHBOARD_RANGE') or '6h'
        if not re.fullmatch(r'[1-9][0-9]*(m|h|d|w)', dashboard_range):
            problems.append('DEFAULT_DASHBOARD_RANGE must be a duration such as 6h.')
        if problems:
            raise ConfigError('Invalid environment: ' + ' '.join(problems))
        return cls(
            port=int(port_text),
            database_url=database_url,
            query_api_url=query_api_url,
            platform_url=platform_url,
            internal_token=token,
            models_file=env.get('MODELS_FILE') or 'config/models.example.yaml',
            openrouter_api_key=env.get('OPENROUTER_API_KEY') or None,
            default_dashboard_range=dashboard_range,
        )
