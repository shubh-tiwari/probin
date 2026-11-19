"""The OpenRouter transport.

The only provider-specific code in the product: it speaks OpenRouter's chat
completions API and nothing else knows that API exists.
"""

from typing import Any

import httpx

from modelrouter.types import CompletionRequest, CompletionResponse


class OpenRouterTransport:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = 'https://openrouter.ai/api/v1',
        timeout_s: float = 60.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip('/')
        self._client = client or httpx.AsyncClient(timeout=timeout_s)

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        payload: dict[str, Any] = {
            'model': request.model,
            'messages': request.messages,
            'max_tokens': request.max_tokens,
            'temperature': 0,
            # Ask for the cost of this call in the response.
            'usage': {'include': True},
        }
        if request.json:
            payload['response_format'] = {'type': 'json_object'}
        response = await self._client.post(
            f'{self._base_url}/chat/completions',
            json=payload,
            headers={'authorization': f'Bearer {self._api_key}'},
        )
        try:
            body: Any = response.json()
        except ValueError:
            body = None
        error = body.get('error') if isinstance(body, dict) else None
        if response.is_error or error:
            message = error.get('message') if isinstance(error, dict) else None
            raise RuntimeError(message or f'provider returned HTTP {response.status_code}')
        choices = body.get('choices') or [{}]
        content = (choices[0].get('message') or {}).get('content')
        if not isinstance(content, str) or content == '':
            raise RuntimeError('provider returned no content')
        usage = body.get('usage') or {}
        cost = usage.get('cost')
        return CompletionResponse(
            content=content,
            model=body.get('model') or None,
            input_tokens=int(usage.get('prompt_tokens') or 0),
            output_tokens=int(usage.get('completion_tokens') or 0),
            cost=float(cost) if isinstance(cost, (int, float)) else None,
        )
