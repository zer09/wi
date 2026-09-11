use super::*;

#[tokio::test]
async fn advanced_feature_requirement_fails_before_authentication() {
    let provider = OpenAiCodexProvider::new(Arc::new(ExplodingAuth));
    for feature in [
        Feature::NativeSteering,
        Feature::ToolSearch,
        Feature::ProgrammaticTools,
        Feature::AsyncTools,
    ] {
        let mut opts = SessionOptions::new("test");
        opts.required_features.push(feature);
        assert!(matches!(
            provider.open_session(opts).await,
            Err(GatewayError::UnsupportedFeature(_))
        ));
    }
}
