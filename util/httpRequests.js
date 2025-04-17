/**
 * Makes a GET fetch request of a given endpoint.
 * @param {*} endpoint - the endpoint to be accessed
 * @returns - the response from the API.
 * @throws - An error if the fetch request failed
 */
const getFromAPI = async (endpoint) => {
  const myHeaders = new Headers();

  const requestOptions = {
      method: 'GET',
      headers: myHeaders,
  };

  const result = fetch(endpoint, requestOptions)
      .then(response => {
          if (response.ok) {
              return response.json();
          }
      })
      .catch(error => {
          throw new Error('Failed GET request');
      });

  return result;
}

/**
* Makes a POST fetch request of a given endpoint.
* @param {*} data - JSON data to be placed in the body
* @param {*} endpoint - the endpoint to be accessed
* @returns - the response from the API.
* @throws - An error if the fetch request failed
*/
const postToAPI = async (data, endpoint) => {
  const myHeaders = new Headers();
  myHeaders.append("Content-Type", "application/json");

  const requestOptions = {
      method: 'POST',
      headers: myHeaders,
      body: JSON.stringify(data),
  };

  const result = fetch(endpoint, requestOptions)
      .then(response => {
          if (response.ok) {
              return response;
          }
      })
      .catch(error => {
          throw new Error('Failed GET request');
      });
  return result;
}

/**
* Makes a PUT fetch request of a given endpoint.
* @param {*} data - JSON data to be placed in the body
* @param {*} endpoint - the endpoint to be accessed
* @returns - the response from the API.
* @throws - An error if the fetch request failed
*/
const updateToAPI = (data, endpoint) => {
  const myHeaders = new Headers();
  myHeaders.append("Content-Type", "application/json");

  const requestOptions = {
      method: 'PUT',
      headers: myHeaders,
      body: JSON.stringify(data),
  };

  const result = fetch(endpoint, requestOptions)
      .then(response => {
          if (response.ok) {
              return response;
          }
      })
      .catch(error => {
          throw new Error('Failed PUT request');
      });
  return result;
}

/**
* Makes a DELETE fetch request of a given endpoint.
* @param {*} endpoint - the endpoint to be accessed
* @returns - the response from the API.
* @throws - An error if the fetch request failed
*/
const deleteFromAPI = (endpoint) => {
  const myHeaders = new Headers();

  const requestOptions = {
      method: 'DELETE',
      headers: myHeaders
  };

  const result = fetch(endpoint, requestOptions)
      .then(response => {
          if (response.ok) {
              return response;
          }
      })
      .catch(error => {
          throw new Error('Failed DELETE request');
      });
  return result;
}

exports.getFromAPI = getFromAPI;
exports.postToAPI = postToAPI;
exports.updateToAPI = updateToAPI;
exports.deleteFromAPI = deleteFromAPI;