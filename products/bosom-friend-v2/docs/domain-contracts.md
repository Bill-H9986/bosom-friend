# 0.2.0 DSH Domain Contracts

Every business domain is owned by a DSH service. The frontend, REST gateway, and Agent all
call the same DSH capability; they never call a standalone product backend.

| Domain | DSH Service | UI/REST entry | Agent tool mapping |
| --- | --- | --- | --- |
| Auth | `AuthService` | `auth/*`, `user/*` | login/account setup is user-driven, no AI tool |
| Accounts | `AccountService` | `channels/*`, `accounts/*` | `bosom_account_*` |
| Content | `ContentService` | `material/*`, `ai/draft-generation/*` | `bosom_content_save_draft`, `bosom_content_*` |
| Media | `MediaService` | `media/*`, `assets/*` | `bosom_media_*` |
| Publish | `PublishService` | `publish/*`, `records/*` | `bosom_publish_content` |
| Data | `DataService` | `statistics/*`, `dashboard/*` | `bosom_platform_sync_works` |
| Reception | `ReceptionService` | `customer-reception/*` | `bosom_reception_*` |
| Platform | `PlatformRuntimeService` | `platform-login/*`, `platform-sync/*` | shared runtime, no standalone worker |

## Contract rules

1. A DSH service definition declares its commands, queries, events, and errors.
2. A provider implements the domain behavior.
3. A consumer is only allowed to call the service definition.
4. An Agent tool calls the same provider as the UI gateway; it does not reimplement business
   logic.
5. A route can be a thin gateway adapter, but it cannot own business state.
6. Legacy `bosom-friend-harness` and standalone product backend routes are migrated into
   these domains, not wrapped.
