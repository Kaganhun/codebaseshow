import {Component} from '@layr/component';
import {throwError} from '@layr/utilities';
import fetch from 'cross-fetch';

const GITHUB_API_BASE_URL = 'https://api.github.com/';
const GITHUB_LOGIN_URL = 'https://github.com/login/oauth/access_token';

const PENDING_ISSUE_MINIMUM_AGE = 10 * 24 * 60 * 60 * 1000; // 10 days

export class GitHub extends Component {
  static async fetchUser({accessToken}: {accessToken: string}) {
    const [userData, emailsData] = await Promise.all([
      this.fetch('user', {accessToken}),
      this.fetch('user/emails', {accessToken})
    ]);

    const githubData = {user: userData, emails: emailsData};

    let {id: githubId, login: username, name, avatar_url: avatarURL} = userData;

    if (!name) {
      name = '';
    }

    let email: string | undefined;

    for (const {email: email_, primary, verified} of emailsData) {
      if (primary && verified) {
        email = email_;
        break;
      }
    }

    if (email === undefined) {
      throwError('Primary email not found', {
        displayMessage: `Couldn't get your email address from GitHub. Please make sure you have a verified primary address in your GitHub account`
      });
    }

    return {githubId, username, email, name, avatarURL, githubData};
  }

  static async fetchRepository({owner, name}: {owner: string; name: string}) {
    let githubData: any;

    try {
      githubData = await this.fetch(`repos/${owner}/${name}`);
    } catch (error: any) {
      if (error.status === 404) {
        throwError('Repository not found', {
          displayMessage: `The specified repository doesn't exist.`,
          code: 'REPOSITORY_NOT_FOUND'
        });
      }

      throw error;
    }

    const {
      owner: {id: ownerId},
      stargazers_count: numberOfStars,
      archived: isArchived,
      has_issues: hasIssues
    } = githubData;

    return {ownerId, numberOfStars, isArchived, hasIssues, githubData};
  }

  static async fetchIssue({owner, name, number}: {owner: string; name: string; number: number}) {
    let data: any;

    try {
      data = await this.fetch(`repos/${owner}/${name}/issues/${String(number)}`);
    } catch (error: any) {
      if (error.status === 404) {
        throwError('Issue not found', {displayMessage: `The specified issue doesn't exist.`});
      }

      throw error;
    }

    const {title, state, html_url: url, created_at: createdAtString} = data;

    const isClosed = state === 'closed';
    const createdAt = new Date(createdAtString);

    return {number, title, isClosed, url, createdAt};
  }

  static async countPendingIssues({owner, name}: {owner: string; name: string}) {
    let issues: any[] = [];

    let page = 1;

    while (page <= 3) {
      const pageIssues = await this.fetch(
        `repos/${owner}/${name}/issues?state=open&per_page=100&page=${String(page)}`
      );

      issues.push(...pageIssues);

      if (pageIssues.length !== 100) {
        break;
      }

      page++;
    }

    issues = issues.filter(
      (issue) =>
        issue.user.type === 'User' &&
        Date.now() - new Date(issue.created_at).valueOf() >= PENDING_ISSUE_MINIMUM_AGE
    );

    return issues.length;
  }

  static async findRepositoryContributor({
    owner,
    name,
    userId
  }: {
    owner: string;
    name: string;
    userId: number;
  }) {
    const contributors = await this.fetch(`repos/${owner}/${name}/contributors?per_page=100`);

    for (const contributor of contributors) {
      if (contributor.id === userId) {
        return {githubData: contributor};
      }
    }

    if (contributors.length === 100) {
      throwError('Cannot fetch more than 100 contributors', {
        displayMessage:
          'The specified repository have a lot of contributors and we are currently unable to fetch them all.'
      });
    }

    return undefined;
  }

  static async readRepositoryFile({
    owner,
    name,
    path
  }: {
    owner: string;
    name: string;
    path: string;
  }) {
    try {
      const data = await this.fetch(`repos/${owner}/${name}/contents/${path}`);

      if (data.type !== 'file') {
        throw new Error(
          `Unsupported type '${data.type}' encountered while reading a file from GitHub`
        );
      }

      if (data.type !== 'file') {
        throw new Error(
          `Unsupported type '${data.type}' encountered while reading a file from GitHub`
        );
      }

      if (data.encoding !== 'base64') {
        throw new Error(
          `Unsupported encoding '${data.type}' encountered while reading a file from GitHub`
        );
      }

      return {content: Buffer.from(data.content, 'base64'), sha: data.sha};
    } catch (error: any) {
      if (error.status === 404) {
        return undefined;
      }

      throw error;
    }
  }

  static async writeRepositoryFile({
    owner,
    name,
    path,
    content,
    message
  }: {
    owner: string;
    name: string;
    path: string;
    content: string;
    message: string;
  }) {
    const previousFile = await this.readRepositoryFile({owner, name, path});

    await this.fetch(`repos/${owner}/${name}/contents/${path}`, {
      method: 'PUT',
      body: {
        content: Buffer.from(content, 'utf-8').toString('base64'),
        message,
        sha: previousFile?.sha
      },
      expectedStatus: previousFile === undefined ? 201 : 200
    });
  }

  static async fetch(
    path: string,
    {
      method = 'GET',
      body,
      expectedStatus,
      accessToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN
    }: {method?: string; body?: any; expectedStatus?: number; accessToken?: string} = {}
  ) {
    const response = await fetch(GITHUB_API_BASE_URL + path, {
      method,
      headers: {
        Accept: 'application/vnd.github.v3+json',
        ...(method === 'POST' && {'Content-Type': 'application/json'}),
        ...(accessToken !== undefined && {Authorization: `token ${accessToken}`})
      },
      ...(body !== undefined && {body: JSON.stringify(body)})
    });

    const result = await response.json();

    if (expectedStatus === undefined) {
      expectedStatus = method === 'POST' ? 201 : 200;
    }

    if (response.status !== expectedStatus) {
      throw Object.assign(
        new Error(
          `An error occurred while fetching the GitHub API (HTTP status: ${
            response.status
          }, result: ${JSON.stringify(result)}).`
        ),
        {status: response.status}
      );
    }

    return result;
  }

  static async fetchAccessToken({code, state}: {code: string; state: string}) {
    const response = await fetch(GITHUB_LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        state
      })
    });

    if (response.status !== 200) {
      throw new Error(
        `An error occurred while getting an access token from GitHub (HTTP status: ${response.status}`
      );
    }

    const {access_token: accessToken} = await response.json();

    return accessToken as string;
  }
}
