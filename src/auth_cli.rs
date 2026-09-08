//! Provider dispatch only; OAuth and file ownership stay in the provider.
use clap::{Args, Subcommand, ValueEnum};
use wi::{
    Result,
    providers::openai_codex::managed_auth::{AuthManager, production_oauth_blocker},
};

#[derive(Clone, Copy, ValueEnum)]
enum ProviderArg {
    OpenaiCodex,
}
#[derive(Args)]
pub struct AuthCommand {
    #[command(subcommand)]
    action: Action,
}
#[derive(Args)]
struct ProviderArgs {
    #[arg(long, value_enum)]
    provider: ProviderArg,
}
#[derive(Args)]
struct AccountArgs {
    #[command(flatten)]
    provider: ProviderArgs,
    #[arg(long)]
    account: String,
}
#[derive(Subcommand)]
enum Action {
    /// Opt-in browser login experiment; provider support is unconfirmed.
    Login {
        #[command(flatten)]
        account: AccountArgs,
        #[arg(long)]
        replace: bool,
        #[arg(long)]
        experimental: bool,
    },
    /// Read local metadata only; no network or renewal.
    List(ProviderArgs),
    /// Read one local profile's metadata only.
    Status(AccountArgs),
    /// Renewal is unavailable, including for experimental browser logins.
    Refresh(AccountArgs),
    /// Delete only this Wi profile. Does not revoke remote credentials.
    Logout(AccountArgs),
}
impl AuthCommand {
    pub async fn run(self) -> Result<()> {
        match self.action {
            Action::Login {
                account,
                experimental,
                replace,
            } => crate::line_json(
                &wi::providers::openai_codex::browser_login::login(
                    account.account,
                    experimental,
                    replace,
                )
                .await?,
            ),
            Action::Refresh(_) => production_oauth_blocker(),
            Action::List(_) => crate::line_json(&AuthManager::default_location()?.list()?),
            Action::Status(args) => {
                crate::line_json(&AuthManager::default_location()?.status(&args.account)?)
            }
            Action::Logout(args) => AuthManager::default_location()?.logout(&args.account),
        }
    }
}
#[cfg(test)]
mod tests {
    use clap::Parser;
    #[test]
    fn auth_cli_rejects_external_profile_and_managed_path_before_reads() {
        for (source, extra) in [
            ("pi", "--account"),
            ("codex", "--account"),
            ("gateway", "--auth-file"),
        ] {
            let cli = crate::Cli::try_parse_from([
                "wi",
                "generate",
                "--auth-source",
                source,
                extra,
                "synthetic",
                "--model",
                "synthetic",
                "--prompt",
                "synthetic",
            ])
            .unwrap();
            let crate::Command::Generate(args) = cli.command else {
                panic!()
            };
            assert!(crate::provider(&args.base.auth).is_err());
        }
    }
    #[tokio::test]
    async fn auth_cli_login_refresh_block_without_ambient_path_resolution() {
        for verb in ["login", "refresh"] {
            let cli = crate::Cli::try_parse_from([
                "wi",
                "auth",
                verb,
                "--provider",
                "openai-codex",
                "--account",
                "synthetic",
            ])
            .unwrap();
            let crate::Command::Auth(command) = cli.command else {
                panic!()
            };
            let error = command.run().await.unwrap_err();
            let expected = if verb == "login" {
                "requires --experimental"
            } else {
                "renewal is unavailable"
            };
            assert!(error.to_string().contains(expected));
        }
    }
}
