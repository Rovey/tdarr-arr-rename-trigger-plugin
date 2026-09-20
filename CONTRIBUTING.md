# Contributing to Tdarr Radarr/Sonarr Rename Trigger Plugin

First off, thank you for considering contributing to this project! 🎉

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples** (file paths, configurations, etc.)
- **Include Tdarr logs** showing the plugin output
- **Describe the behavior you observed** and what you expected
- **Include your environment details**:
  - Tdarr version
  - Radarr/Sonarr version
  - Operating system
  - Docker or native installation

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, include:

- **Use a clear and descriptive title**
- **Provide a detailed description** of the suggested enhancement
- **Explain why this enhancement would be useful**
- **List any alternative solutions** you've considered

### Pull Requests

1. **Fork the repository** and create your branch from `main`
2. **Make your changes** following the coding style of the project
3. **Test your changes** thoroughly with both Radarr and Sonarr
4. **Update documentation** (README.md, CHANGELOG.md) if needed
5. **Commit your changes** with clear, descriptive commit messages
6. **Push to your fork** and submit a pull request

#### Pull Request Guidelines

- Keep pull requests focused on a single feature or bug fix
- Include a clear description of the changes and why they're needed
- Update the CHANGELOG.md with your changes
- Ensure the plugin still works with both Radarr and Sonarr
- Test with various file path configurations
- Include log output examples if relevant

## Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/Rovey/Tdarr-arr-rename-trigger-plugin.git
   cd Tdarr-arr-rename-trigger-plugin
   ```

2. Run the test suite:
   ```bash
   npm test
   ```
   It uses Node's built-in test runner (Node 18+), so no `npm install` and no network access are
   needed — the tests live in `tests/` and mock everything the plugin talks to.

3. Copy the plugin to your Tdarr plugins directory for testing

4. Make your changes and test in Tdarr

## Coding Standards

- Use consistent indentation (4 spaces)
- Add comments for complex logic
- Keep functions focused and single-purpose
- Use descriptive variable names
- Follow the existing code style
- Include error handling for API calls
- Add informative log messages using `response.infoLog`

## Testing Checklist

Before submitting a pull request, verify:

- [ ] `npm test` passes
- [ ] Plugin loads successfully in Tdarr
- [ ] Path detection works for both Radarr and Sonarr
- [ ] File lookup works by path and by ID
- [ ] API commands execute successfully (201 status codes)
- [ ] Error handling works properly
- [ ] Logs are clear and informative
- [ ] Enable/disable toggles work correctly
- [ ] Path matching is case-insensitive
- [ ] Works with Docker and native Tdarr installations

## Questions?

Feel free to open an issue with the "question" label if you need help or clarification.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
