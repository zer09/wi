//! Provider dispatch only; OAuth and file ownership stay in the provider.
use clap::{Args, Subcommand, ValueEnum};
use wi::{Result, providers::openai_codex::managed_auth::AuthManager};

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
    /// Renew one Wi profile through the experimental token exchange.
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
            } => crate::cli::line_json(
                &wi::providers::openai_codex::browser_login::login(
                    account.account,
                    experimental,
                    replace,
                )
                .await?,
            ),
            Action::Refresh(args) => {
                let manager = AuthManager::default_location()?;
                manager.refresh(&args.account).await?;
                crate::cli::line_json(&manager.status(&args.account)?)
            }
            Action::List(_) => crate::cli::line_json(&AuthManager::default_location()?.list()?),
            Action::Status(args) => {
                crate::cli::line_json(&AuthManager::default_location()?.status(&args.account)?)
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
            let cli = crate::cli::Cli::try_parse_from([
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
            let crate::cli::Command::Generate(args) = cli.command else {
                panic!()
            };
            assert!(crate::cli::provider(&args.base.auth).is_err());
        }
    }
    #[tokio::test]
    async fn auth_cli_login_blocks_without_ambient_path_resolution() {
        let cli = crate::cli::Cli::try_parse_from([
            "wi",
            "auth",
            "login",
            "--provider",
            "openai-codex",
            "--account",
            "synthetic",
        ])
        .unwrap();
        let crate::cli::Command::Auth(command) = cli.command else {
            panic!()
        };
        let error = command.run().await.unwrap_err();
        assert!(error.to_string().contains("requires --experimental"));
    }
}
