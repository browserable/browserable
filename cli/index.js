#!/usr/bin/env node

// Suppress experimental warnings
process.removeAllListeners('warning');

import { program } from 'commander';
import { execa } from 'execa';
import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import open from 'open';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const spinner = ora();
const REPO_URL = 'https://github.com/browserable/browserable.git';
const REPO_FOLDER = 'browserable';

// Function to check if we're in a valid directory for running commands
function validateDirectory() {
  const currentDir = process.cwd();
  const currentDirName = path.basename(currentDir);
  const parentDir = path.dirname(currentDir);
  const parentDirName = path.basename(parentDir);

  // Case 1: We are inside the browserable repo
  if (currentDirName === 'browserable') {
    return {
      valid: true,
      inRepo: true,
      repoPath: '.'
    };
  }

  // Case 2: We have browserable folder in current directory
  if (fs.existsSync(path.join(currentDir, 'browserable'))) {
    return {
      valid: true,
      inRepo: false,
      repoPath: './browserable'
    };
  }

  return {
    valid: false,
    inRepo: false,
    repoPath: null
  };
}

// Function to get the correct path for repo operations
function getRepoPath() {
  const { inRepo, repoPath } = validateDirectory();
  return inRepo ? '.' : './browserable';
}

async function checkDocker() {
  try {
    await execa('docker', ['--version']);
    return true;
  } catch (error) {
    return false;
  }
}

async function checkDockerCompose() {
  try {
    await execa('docker-compose', ['--version']);
    return true;
  } catch (error) {

    // the new docker compose might be "docker compose"
    try {
      await execa('docker', ['compose', 'version']);
      return true;
    } catch (error) {
      return false;
    }
  }
}

async function checkNodeAndNpm() {
  try {
    await execa('node', ['-v']);
    await execa('npm', ['-v']);
    return true;
  } catch (error) {
    console.log(chalk.yellow('\nNode.js or npm is not installed on your system.'));
    console.log(chalk.blue('\nPlease visit: https://nodejs.org/en/download to install Node.js and npm for your operating system.'));
    console.log(chalk.yellow('\nAfter installing Node.js and npm, please run this command again.'));
    return false;
  }
}

async function cloneRepo() {
  const { valid, inRepo, repoPath } = validateDirectory();
  
  // If we're already in the repo or have it in current directory
  if (valid && fs.existsSync(repoPath)) {
    console.log(chalk.yellow('Browserable folder already exists, skipping clone step.'));
    return true;
  }

  // Before cloning, ask for confirmation
  const { proceed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'proceed',
      message: 'This will clone the Browserable repository in the current directory. Do you want to proceed?',
      default: true,
    },
  ]);

  if (!proceed) {
    console.log(chalk.yellow('Setup cancelled by user.'));
    return false;
  }

  spinner.start('Cloning repository...');
  try {
    await execa('git', ['clone', REPO_URL]);
    spinner.succeed('Repository cloned successfully');
    return true;
  } catch (error) {
    spinner.fail('Failed to clone repository');
    console.error(chalk.red(error.message));
    return false;
  }
}

async function dockerBaseCommand() {
  // if docker compose version works, return docker compose. else return docker-compose
  try {
    await execa('docker', ['compose', 'version']);
    return 'docker compose';
  } catch (error) {
    return 'docker-compose';
  }
}

async function startDockerCompose() {
  spinner.stop();
  console.log(chalk.blue('Building Docker containers...'));
  const dockerCmd = await dockerBaseCommand();
  const repoPath = getRepoPath();
  const originalDir = process.cwd();
  
  try {
    process.chdir(path.join(repoPath, 'deployment'));
    // Split the command into parts if it's 'docker compose'
    if (dockerCmd === 'docker compose') {
      // First build
      await execa('docker', ['compose', '-f', 'docker-compose.dev.yml', 'build'], {
        stdio: 'inherit'
      });
      // Then start
      console.log(chalk.blue('\nStarting Docker containers...'));
      await execa('docker', ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d'], {
        stdio: 'inherit'
      });
    } else {
      // First build
      await execa(dockerCmd, ['-f', 'docker-compose.dev.yml', 'build'], {
        stdio: 'inherit'
      });
      // Then start
      console.log(chalk.blue('\nStarting Docker containers...'));
      await execa(dockerCmd, ['-f', 'docker-compose.dev.yml', 'up', '-d'], {
        stdio: 'inherit'
      });
    }
    console.log(chalk.green('\nDocker containers built and started successfully'));
    // Restore original directory
    process.chdir(originalDir);
    return true;
  } catch (error) {
    // Restore original directory even on error
    process.chdir(originalDir);
    console.error(chalk.red('Failed to build or start Docker containers'));
    console.error(chalk.red(error.message));
    return false;
  }
}

async function setupBrowserService() {
  spinner.start('Setting up browser service...');
  const repoPath = getRepoPath();
  
  try {
    process.chdir(path.join(repoPath, 'browser'));
    console.log(chalk.blue('\nInstalling browser service dependencies...'));
    await execa('npm', ['install'], { stdio: 'inherit' });
    console.log(chalk.green('\nBrowser service dependencies installed successfully'));
    
    // install playwright browsers with npx playwright install
    console.log(chalk.blue("\nInstalling playwright browsers..."));
    await execa("npx", ["playwright", "install"], { stdio: "inherit" });
    console.log(chalk.green("\nPlaywright browsers installed successfully"));
    
    console.log(chalk.blue('\nStarting browser service...'));
    await execa('npm', ['start'], { stdio: 'inherit' });
    return true;
  } catch (error) {
    spinner.fail('Failed to setup browser service');
    console.error(chalk.red(error.message));
    return false;
  }
}

async function downServices() {
  const { valid } = validateDirectory();
  if (!valid) {
    console.log(chalk.red('Error: This command must be run either inside the browserable repository or in a directory containing the browserable repository.'));
    return false;
  }

  spinner.start('Stopping Docker services...');
  const dockerCmd = await dockerBaseCommand();
  const repoPath = getRepoPath();
  
  try {
    process.chdir(path.join(repoPath, 'deployment'));
    if (dockerCmd === 'docker compose') {
      await execa('docker', ['compose', '-f', 'docker-compose.dev.yml', 'down'], {
        stdio: 'inherit'
      });
    } else {
      await execa(dockerCmd, ['-f', 'docker-compose.dev.yml', 'down'], {
        stdio: 'inherit'
      });
    }
    spinner.succeed('Docker services stopped successfully');
    return true;
  } catch (error) {
    spinner.fail('Failed to stop Docker services');
    console.error(chalk.red(error.message));
    return false;
  }
}

async function main() {
  console.log(chalk.blue('Welcome to Browserable Setup!'));
  
  // Check and install Docker if needed
  if (!(await checkDocker())) {
    console.log(chalk.yellow('\nDocker is not installed on your system.'));
    console.log(chalk.blue('\nPlease visit: https://docs.docker.com/engine/install/ to install Docker for your operating system.'));
    console.log(chalk.yellow('\nAfter installing Docker, please run this command again.'));
    return;
  }

  // Check and install Docker Compose if needed
  if (!(await checkDockerCompose())) {
    console.log(chalk.yellow('\nDocker Compose is not installed on your system.'));
    console.log(chalk.blue('\nPlease visit: https://docs.docker.com/compose/install/ to install Docker Compose for your operating system.'));
    console.log(chalk.yellow('\nAfter installing Docker Compose, please run this command again.'));
    return;
  }

  // Check Node.js and npm
  if (!(await checkNodeAndNpm())) {
    return;
  }

  // Clone repository
  if (!(await cloneRepo())) {
    return;
  }

  // Start Docker Compose
  if (!(await startDockerCompose())) {
    return;
  }

  console.log(chalk.green('\n🎉 Browserable is now running!'));
  console.log(chalk.blue('\nYou can access admin ui at: http://localhost:2001'));
  console.log(chalk.blue('\nYou can access the documentation at: http://localhost:2002'));
  console.log(chalk.blue('\nYou can access the api at: http://localhost:2003'));
  console.log(chalk.blue('\nYou can access database studio at: http://localhost:8000'));
  console.log(chalk.blue('\nYou can access mongo express at: http://localhost:3300'));
  console.log(chalk.blue('\nYou can access minio S3 storage at: http://localhost:9001'));
  console.log(chalk.blue('\nYou can access redis queue system at: http://localhost:2003/admin/queues'));
  
  console.log(chalk.blue('\nSetting up local browser service...'));
  if (!(await setupBrowserService())) {
    return;
  }

  // Open admin UI in default browser
  try {
    await open('http://localhost:2001');
    console.log(chalk.green('\nOpened admin UI in your default browser'));
  } catch (error) {
    console.log(chalk.yellow('\nCould not automatically open browser. Please open http://localhost:2001 manually'));
  }

  console.log(chalk.yellow('\nTo stop the application, run: docker-compose down'));
}

program
  .name('browserable')
  .description(`CLI to setup and run Browserable

  Examples:
    $ browserable           # Setup and start all services
    $ browserable start     # Same as above
    $ browserable down      # Stop all Docker services`)
  .version(packageJson.version);

// Default command (no command specified)
program
  .command('start', { isDefault: true })
  .description('Setup and start Browserable services (default command)')
  .action(main);

// Down command
program
  .command('down')
  .description(`Stop all Browserable Docker services
  
  This command will:
  - Stop all Docker containers
  - Remove containers (preserving data volumes)
  
  Note: This command must be run either inside the browserable repository or in a directory containing the browserable repository.`)
  .action(async () => {
    const { valid } = validateDirectory();
    if (!valid) {
      console.log(chalk.red('Error: This command must be run either inside the browserable repository or in a directory containing the browserable repository.'));
      return;
    }

    // Check if Docker is installed first
    if (!(await checkDocker())) {
      console.log(chalk.yellow('\nDocker is not installed on your system.'));
      console.log(chalk.blue('\nPlease visit: https://docs.docker.com/engine/install/ to install Docker for your operating system.'));
      return;
    }

    // Check if Docker Compose is installed
    if (!(await checkDockerCompose())) {
      console.log(chalk.yellow('\nDocker Compose is not installed on your system.'));
      console.log(chalk.blue('\nPlease visit: https://docs.docker.com/compose/install/ to install Docker Compose for your operating system.'));
      return;
    }

    await downServices();
  });

program.parse(); 
